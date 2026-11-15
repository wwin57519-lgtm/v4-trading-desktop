const CONFIG=require('./config.cjs');
function migrate(data){const selected=data.selectedChainId??8453;CONFIG.forChain(selected);return {schemaVersion:2,networks:{},...data,selectedChainId:selected};}
module.exports={migrate};
