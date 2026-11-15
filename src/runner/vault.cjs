'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { Wallet, getAddress } = require('ethers');

const scrypt = promisify(crypto.scrypt);
const MAX_WALLETS = 500;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_FILE_BYTES = 128 * 1024;
const KDF = Object.freeze({ name: 'scrypt', N: 32768, r: 8, p: 1 });
const PURPOSE = 'v4-trading-desktop-trigger-vault';
const failure = (code, message) => Object.assign(new Error(message), { code });
function passphrase(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 1024) {
    throw failure('VAULT_PASSWORD_LENGTH', '钱包密码长度必须为 10–1024 个字符');
  }
}
function address(value) {
  try { return getAddress(value); } catch { throw failure('VAULT_ADDRESS', '钱包地址无效'); }
}
function exactKeys(object, keys) {
  return object && typeof object === 'object' && !Array.isArray(object)
    && Object.keys(object).length === keys.length && keys.every(k => Object.hasOwn(object, k));
}
function decode64(value, length, maximum = length) {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw failure('VAULT_FORMAT', '加密钱包文件格式无效');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < length || decoded.length > maximum || decoded.toString('base64') !== value) {
    throw failure('VAULT_FORMAT', '加密钱包文件格式无效');
  }
  return decoded;
}
function aad(envelope) {
  return Buffer.from(JSON.stringify({ purpose: PURPOSE, version: 1, kdf: envelope.kdf, cipher: envelope.cipher }));
}
function parseEnvelope(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch { throw failure('VAULT_FORMAT', '加密钱包文件格式无效'); }
  if (!exactKeys(obj, ['version', 'kdf', 'cipher', 'ciphertext', 'tag']) || obj.version !== 1
      || !exactKeys(obj.kdf, ['name', 'N', 'r', 'p', 'salt'])
      || obj.kdf.name !== KDF.name || obj.kdf.N !== KDF.N || obj.kdf.r !== KDF.r || obj.kdf.p !== KDF.p
      || !exactKeys(obj.cipher, ['name', 'iv']) || obj.cipher.name !== 'aes-256-gcm') {
    throw failure('VAULT_FORMAT', '加密钱包文件版本或加密参数无效');
  }
  // Validate every dimension before running any attacker-controlled KDF input.
  return { envelope: obj, salt: decode64(obj.kdf.salt, 32), iv: decode64(obj.cipher.iv, 12),
    tag: decode64(obj.tag, 16), ciphertext: decode64(obj.ciphertext, 1, 64 * 1024) };
}
function jsonRows(text, values) {
  // Track physical line numbers of top-level array elements without evaluating input.
  let depth = 0, quoted = false, escaped = false, needValue = false, line = 1;
  const lines = [];
  for (const c of text) {
    if (c === '\n') line++;
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (depth === 1 && needValue && !/\s/.test(c) && c !== ']') { lines.push(line); needValue = false; }
    if (c === '"') quoted = true;
    else if (c === '[' || c === '{') { depth++; if (depth === 1) needValue = true; }
    else if (c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 1) needValue = true;
  }
  return values.map((key, i) => ({ key, line: lines[i] || 1 }));
}
function inputRows(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
    throw failure('VAULT_INPUT', '钱包导入内容过大或格式无效');
  }
  text = text.replace(/^\uFEFF/, '');
  if (text.trimStart().startsWith('[')) {
    let values;
    try { values = JSON.parse(text); } catch { return [{ line: 1, key: null }]; }
    if (!Array.isArray(values)) return [{ line: 1, key: null }];
    return jsonRows(text, values);
  }
  const rows = [];
  let first = true;
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const cells = raw.split(',').map(x => {
      const t = x.trim();
      return /^"[^"\r\n]*"$/.test(t) ? t.slice(1, -1).trim() : t;
    });
    if (first && cells.length === 2 && cells[0].toLowerCase() === 'address' && cells[1].toLowerCase() === 'privatekey') { first = false; continue; }
    first = false;
    rows.push(cells.length === 1 ? { line: i + 1, key: cells[0] }
      : cells.length === 2 ? { line: i + 1, address: cells[0], key: cells[1] }
        : { line: i + 1, key: null });
  }
  return rows;
}
function walletFor(row) {
  if (typeof row.key !== 'string' || !/^(?:0x)?[0-9a-fA-F]{64}$/i.test(row.key.trim())) return null;
  try {
    const key = row.key.trim().replace(/^0x/i, '');
    const wallet = new Wallet('0x' + key);
    if (row.address !== undefined && getAddress(row.address) !== wallet.address) return null;
    return wallet;
  } catch { return null; }
}

class Vault {
  #file;
  #wallets = new Map();
  #locked;
  #revision = 0;
  #busy = false;
  constructor({ file } = {}) {
    if (typeof file !== 'string' || !file.trim()) throw failure('VAULT_FILE', '需要本地加密钱包文件路径');
    this.#file = path.resolve(file);
    this.#locked = fs.existsSync(this.#file);
  }
  get count() { return this.#wallets.size; }
  info() { return { saved: fs.existsSync(this.#file), locked: this.#locked, count: this.count }; }
  list() { return [...this.#wallets.values()].map(wallet => ({ address: wallet.address })); }
  has(value) { try { return this.#wallets.has(address(value).toLowerCase()); } catch { return false; } }
  getSigner(value) {
    const signer = this.#wallets.get(address(value).toLowerCase());
    if (!signer || this.#locked) throw failure('VAULT_LOCKED', '钱包尚未导入或已锁定');
    // Main-process-only API. A Wallet must never be returned over renderer IPC.
    return signer;
  }
  import(text) {
    if (this.#locked && fs.existsSync(this.#file)) {
      throw failure('VAULT_UNLOCK_REQUIRED', '请先解锁已有保险库，再添加钱包；不会覆盖尚未解锁的旧钱包');
    }
    const rows = inputRows(text), candidates = new Map(), invalidLines = [];
    let duplicates = 0;
    for (const row of rows) {
      const wallet = walletFor(row);
      if (!wallet) { invalidLines.push(row.line); continue; }
      const id = wallet.address.toLowerCase();
      if (this.#wallets.has(id) || candidates.has(id)) duplicates++;
      else candidates.set(id, wallet);
    }
    if (invalidLines.length) return { imported: 0, count: this.count, invalidLines: [...new Set(invalidLines)], duplicates };
    if (this.count + candidates.size > MAX_WALLETS) throw failure('VAULT_LIMIT', '最多可导入 500 个不同钱包');
    if (candidates.size) {
      for (const [id, wallet] of candidates) this.#wallets.set(id, wallet);
      this.#revision++;
      this.#locked = false;
    }
    return { imported: candidates.size, count: this.count, invalidLines: [], duplicates };
  }
  clear() {
    // JavaScript strings cannot be securely zeroed. Release this class's references;
    // callers holding a signer must also cancel work and release their references.
    this.#wallets.clear(); this.#revision++; this.#locked = fs.existsSync(this.#file);
    return this.info();
  }
  lock() { this.#wallets.clear(); this.#revision++; this.#locked = true; return this.info(); }
  #startOperation() {
    if (this.#busy) throw failure('VAULT_BUSY', '钱包加密操作正在进行');
    this.#busy = true;
    return this.#revision;
  }
  #checkRevision(revision) {
    if (revision !== this.#revision) throw failure('VAULT_CHANGED', '钱包状态已改变，请重新操作');
  }
  async save(password) {
    passphrase(password);
    if (this.#locked || !this.count) throw failure('VAULT_EMPTY', '请先导入或解锁钱包');
    const revision = this.#startOperation();
    let plaintext, derived, secret;
    try {
      plaintext = Buffer.from(JSON.stringify({ version: 1, privateKeys: [...this.#wallets.values()].map(w => w.privateKey) }));
      secret = Buffer.from(password, 'utf8');
      const salt = crypto.randomBytes(32), iv = crypto.randomBytes(12);
      derived = await scrypt(secret, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
      this.#checkRevision(revision);
      const envelope = { version: 1, kdf: { ...KDF, salt: salt.toString('base64') }, cipher: { name: 'aes-256-gcm', iv: iv.toString('base64') } };
      const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
      cipher.setAAD(aad(envelope));
      envelope.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
      envelope.tag = cipher.getAuthTag().toString('base64');
      this.#atomicWrite(JSON.stringify(envelope));
      return this.info();
    } catch (error) {
      if (error?.code?.startsWith('VAULT_')) throw error;
      throw failure('VAULT_SAVE', '加密钱包保存失败，原文件未主动删除');
    } finally { plaintext?.fill(0); derived?.fill(0); secret?.fill(0); this.#busy = false; }
  }
  async unlock(password) {
    passphrase(password);
    const revision = this.#startOperation();
    let derived, plaintext, secret;
    try {
      const stat = fs.statSync(this.#file);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size < 1) throw failure('VAULT_FORMAT', '加密钱包文件大小或类型无效');
      const raw = fs.readFileSync(this.#file);
      if (raw.length > MAX_FILE_BYTES) throw failure('VAULT_FORMAT', '加密钱包文件过大');
      const { envelope, salt, iv, tag, ciphertext } = parseEnvelope(raw.toString('utf8'));
      secret = Buffer.from(password, 'utf8');
      derived = await scrypt(secret, salt, 32, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 64 * 1024 * 1024 });
      this.#checkRevision(revision);
      let parsed;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', derived, iv);
        decipher.setAAD(aad(envelope)); decipher.setAuthTag(tag);
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        parsed = JSON.parse(plaintext.toString('utf8'));
      } catch { throw failure('VAULT_UNLOCK', '密码错误或加密钱包文件已损坏'); }
      if (!exactKeys(parsed, ['version', 'privateKeys']) || parsed.version !== 1 || !Array.isArray(parsed.privateKeys)
          || parsed.privateKeys.length < 1 || parsed.privateKeys.length > MAX_WALLETS) throw failure('VAULT_FORMAT', '解密的钱包内容格式无效');
      const restored = new Map();
      for (const key of parsed.privateKeys) {
        const wallet = walletFor({ key });
        if (!wallet || restored.has(wallet.address.toLowerCase())) throw failure('VAULT_FORMAT', '解密的钱包内容无效');
        restored.set(wallet.address.toLowerCase(), wallet);
      }
      this.#wallets = restored; this.#locked = false; this.#revision++;
      return this.info();
    } catch (error) {
      if (error?.code?.startsWith('VAULT_')) throw error;
      throw failure('VAULT_UNLOCK', '无法读取或解密钱包文件');
    } finally { plaintext?.fill(0); derived?.fill(0); secret?.fill(0); this.#busy = false; }
  }
  #atomicWrite(data) {
    const dir = path.dirname(this.#file);
    fs.mkdirSync(dir, { recursive: true });
    const temp = path.join(dir, '.' + path.basename(this.#file) + '.' + crypto.randomBytes(12).toString('hex') + '.tmp');
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, data, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, this.#file);
      // Windows does not support directory fsync. File contents were synced first.
      if (process.platform !== 'win32') { let d; try { d = fs.openSync(dir, 'r'); fs.fsyncSync(d); } finally { if (d !== undefined) fs.closeSync(d); } }
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
      try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') { /* Keep the original write error, with no secret-bearing payload. */ } }
    }
  }
}

module.exports = { Vault };
