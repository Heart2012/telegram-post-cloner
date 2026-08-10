// Fix the per-link UI menu without changing the stable link-settings-live2.js core.
// The live2 middleware currently hides the create/delete buttons from its link list.
// This loader patches only the menu function before link-settings-live2.js is compiled.
const Module = require("module");
const fs = require("fs");
const path = require("path");

if (!Module._extensions.__postClonerLinksUiFix) {
  const original = Module._extensions[".js"];
  Module._extensions[".js"] = function (module, filename) {
    if (path.basename(filename) !== "link-settings-live2.js") {
      return original(module, filename);
    }

    let source = fs.readFileSync(filename, "utf8");
    const oldMenu = "function menu(ctx){const rows=links().map(r=>[Markup.button.callback(`🔗 ${r.source_title} → ${r.destination_title}`.slice(0,60),`ls_open_${r.id}`)]);rows.push([Markup.button.callback(T(ctx,'🔄 Обновить','🔄 Оновити'),'ls_menu')]);return Markup.inlineKeyboard(rows)}";
    const newMenu = "function menu(ctx){const rows=links().map(r=>[Markup.button.callback(`🔗 ${r.source_title} → ${r.destination_title}`.slice(0,60),`ls_open_${r.id}`)]);rows.push([Markup.button.callback(T(ctx,'➕ Создать связку','➕ Створити зв’язок')),'link_create')]);rows.push([Markup.button.callback(T(ctx,'🗑 Удалить связку','🗑 Видалити зв’язок'),'link_delete_menu')]);rows.push([Markup.button.callback(T(ctx,'🔄 Обновить','🔄 Оновити'),'ls_menu')]);return Markup.inlineKeyboard(rows)}";

    if (source.includes(oldMenu)) {
      source = source.replace(oldMenu, newMenu);
    } else if (!source.includes("link_create")) {
      console.error("links-ui-fix: target menu pattern was not found");
    }

    module._compile(source, filename);
  };
  Module._extensions.__postClonerLinksUiFix = true;
}
