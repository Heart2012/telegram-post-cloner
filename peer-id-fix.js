// Telegram peer-ID fix.
// GramJS uses marked peer IDs for channels/supergroups (for example -100...).
// The old cloner stored entity.id (positive) while message.chatId is marked,
// so the source check failed and nothing was copied.
// This loader patches the final compiled core.js without replacing core.js itself.

const Module = require("module");
const fs = require("fs");
const path = require("path");

if (!Module._extensions.__postClonerPeerIdFix) {
  const previous = Module._extensions[".js"];

  Module._extensions[".js"] = function (module, filename) {
    if (path.basename(filename) !== "core.js") {
      return previous(module, filename);
    }

    const originalCompile = module._compile;
    module._compile = function (source, file) {
      let s = source;

      // Use GramJS' canonical marked peer ID for newly added chats.
      s = s.replace(
        'const { TelegramClient } = require("telegram");',
        'const { TelegramClient, utils } = require("telegram");'
      );

      s = s.replace(
        /async function info\(entity\)\{const id=Number\(entity\.id\?\.value\?\?entity\.id\);/,
        'async function info(entity){const id=Number(utils.getPeerId(entity));'
      );

      // Forwarded channels/groups must also be stored with the same marked ID.
      s = s.replace(
        /const id=Number\(chat\.id\);if\(!id\)throw new Error\("Не удалось определить ID чата\."\);let title=chat\.title\|\|chat\.username\|\|String\(id\);let username=chat\.username\|\|null;try\{const entity=await client\.getEntity\(id\);title=entity\.title\|\|title;username=entity\.username\|\|username\|\|null;\}catch\(_\)\{\}/,
        'let entity=null;try{entity=await client.getEntity(chat);}catch(_){};const id=entity?Number(utils.getPeerId(entity)):Number(chat.id);if(!id)throw new Error("Не удалось определить ID чата.");let title=chat.title||chat.username||String(id);let username=chat.username||null;if(entity){title=entity.title||title;username=entity.username||username||null;}'
      );

      // Migrate existing positive IDs saved by older versions.
      const marker = 'function __pcNormalizeStoredChats';
      if (!s.includes(marker)) {
        const insertBefore = 'async function connectSavedSession(){';
        const helper = `async function __pcNormalizeStoredChats(){
  if(!client)return;
  for(const table of ["sources","destinations"]){
    const rows=db.prepare("SELECT id,chat_id,username FROM "+table+" WHERE chat_id>0").all();
    for(const row of rows){
      let entity=null;
      if(row.username){try{entity=await client.getEntity(row.username);}catch(_){}}
      if(!entity){try{entity=await client.getEntity(-1000000000000-Number(row.chat_id));}catch(_){}}
      if(!entity){try{entity=await client.getEntity(-Number(row.chat_id));}catch(_){}}
      if(!entity)continue;
      try{
        const marked=Number(utils.getPeerId(entity));
        if(marked!==Number(row.chat_id)){
          try{db.prepare("UPDATE "+table+" SET chat_id=? WHERE id=?").run(marked,row.id);}catch(e){console.error("Peer ID migration error:",e?.message||e);}
        }
      }catch(_){ }
    }
  }
}

`;
        s = s.replace(insertBefore, helper + insertBefore);
      }

      // Normalize old DB rows before event handlers are attached.
      s = s.replace(
        'try{setupHandlers();}catch(e){console.error("Handler setup error after restore:",e);}',
        'try{await __pcNormalizeStoredChats();setupHandlers();}catch(e){console.error("Handler setup error after restore:",e);}'
      );
      s = s.replace(
        'try{setupHandlers();}catch(e){console.error("Handler setup error after login:",e);}',
        'try{await __pcNormalizeStoredChats();setupHandlers();}catch(e){console.error("Handler setup error after login:",e);}'
      );

      // Also make the event-side source ID canonical even if migration could not resolve a private chat.
      s = s.replace(
        'const sourceChatId=Number(messages[0].chatId?.value??messages[0].chatId);',
        'const sourceChatId=Number(utils.getPeerId(messages[0].peerId||messages[0].chatId));'
      );

      originalCompile.call(module, s, file);
    };

    try {
      previous(module, filename);
    } finally {
      module._compile = originalCompile;
    }
  };

  Module._extensions.__postClonerPeerIdFix = true;
}

console.log("Telegram peer-ID compatibility fix loaded.");
