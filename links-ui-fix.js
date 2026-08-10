// Runtime compatibility patch for the current GramJS version + link UI.
const Module = require("module");
const fs = require("fs");
const path = require("path");

if (!Module._extensions.__postClonerPatch) {
  const original = Module._extensions[".js"];
  Module._extensions[".js"] = function (module, filename) {
    const base = path.basename(filename);
    let source = fs.readFileSync(filename, "utf8");

    if (base === "link-settings-live2.js") {
      const oldMenu = "function menu(ctx){const rows=links().map(r=>[Markup.button.callback(`🔗 ${r.source_title} → ${r.destination_title}`.slice(0,60),`ls_open_${r.id}`)]);rows.push([Markup.button.callback(T(ctx,'🔄 Обновить','🔄 Оновити'),'ls_menu')]);return Markup.inlineKeyboard(rows)}";
      const newMenu = "function menu(ctx){const rows=links().map(r=>[Markup.button.callback(`🔗 ${r.source_title} → ${r.destination_title}`.slice(0,60),`ls_open_${r.id}`)]);rows.push([Markup.button.callback(T(ctx,'➕ Создать связку','➕ Створити зв’язок'),'link_create')]);rows.push([Markup.button.callback(T(ctx,'🗑 Удалить связку','🗑 Видалити зв’язок'),'link_delete_menu')]);rows.push([Markup.button.callback(T(ctx,'🔄 Обновить','🔄 Оновити'),'ls_menu')]);return Markup.inlineKeyboard(rows)}";
      if (source.includes(oldMenu)) source = source.replace(oldMenu, newMenu);
      return module._compile(source, filename);
    }

    if (base === "core.js") {
      // GramJS 2.26.x in this deployment does not expose events.Album as a constructor.
      // NewMessage is sufficient for the current forwarding path.
      source = source.replace(/client\.addEventHandler\(async e=>\{try\{await processMessages\(\(e\.messages\|\|\[\]\)\.sort\(\(a,b\)=>Number\(a\.id\)-Number\(b\.id\)\)\);\}catch\(err\)\{console\.error\("Album:",err\);\}\}\s*,new events\.Album\(\{\}\)\);/g, "");

      if (!source.includes("async function processMessages(messages)") && source.includes("async function setupHandlers()")) {
        const fn = `
async function processMessages(messages){
  if(!messages?.length||!client)return;
  const sourceChatId=Number(messages[0].chatId?.value??messages[0].chatId);
  if(!sourceChatId){console.log("FORWARDER: message without chatId");return;}
  const sourceRow=db.prepare("SELECT 1 FROM sources WHERE chat_id=?").get(sourceChatId);
  if(!sourceRow){console.log(\`FORWARDER: ignored message \${messages[0].id} from chat \${sourceChatId} (not a configured source)\`);return;}
  const rows=destFor.all(sourceChatId);
  console.log(\`FORWARDER: event source=\${sourceChatId} message=\${messages[0].id} destinations=\${rows.length}\`);
  for(const row of rows){
    const destinationChatId=Number(row.chat_id);
    for(const m of messages){
      const messageId=Number(m.id);
      if(copied.get(sourceChatId,messageId,destinationChatId))continue;
      try{
        const delay=Math.max(0,Math.min(3600,Number(getSetting("delay","0"))||0));
        if(delay)await new Promise(r=>setTimeout(r,delay*1000));
        const destination=await client.getEntity(destinationChatId);
        const text=transformText(m.message||"");
        if(text===null||(!text&&!m.media))continue;
        let sent;
        if(m.media) sent=await client.sendFile(destination,{file:m.media,caption:text||undefined,forceDocument:false});
        else sent=await client.sendMessage(destination,{message:text,linkPreview:false});
        if(sent) mark.run(sourceChatId,messageId,destinationChatId,Number(sent.id));
        console.log(\`FORWARDER COPIED \${sourceChatId}:\${messageId} -> \${destinationChatId}\`);
      }catch(e){console.error(\`FORWARDER COPY ERROR \${sourceChatId}:\${messageId} -> \${destinationChatId}:\`,e?.stack||e?.message||e);}
    }
  }
}
`;
        source = source.replace("async function setupHandlers(){", fn + "\nasync function setupHandlers(){");
      }
      return module._compile(source, filename);
    }

    return original(module, filename);
  };
  Module._extensions.__postClonerPatch = true;
}
