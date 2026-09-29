// Every word the Templates surfaces show, from the strings.templates.*
// Settings (docs/spec/templates.md, "Strings"), so the Agent can reword them.

import type { PlaceholderType, Settings } from "@monday/shared";

export interface TemplateUiStrings {
  title: string;
  hint: string;
  pickerEmpty: string;
  pickerSearch: string;
  pickerYours: string;
  pickerBuiltin: string;
  fillFirst: string;
  typeIt: string;
  candidates: string;
  noCandidates: string;
  useEverywhere: string;
  changeEverywhere: string;
  onlyHere: string;
  changeWhere: string;
  restore: string;
  newTemplate: string;
  edit: string;
  delete: string;
  deleted: string;
  undo: string;
  save: string;
  cancel: string;
  hide: string;
  show: string;
  hiddenCount: string;
  export: string;
  import: string;
  exported: string;
  imported: string;
  importFailed: string;
  failed: string;
  invalid: string;
  badgeBuiltin: string;
  badgeEdited: string;
  badgeEverywhere: string;
  badgeAgent: string;
  fieldName: string;
  fieldFitsWhen: string;
  fieldKind: string;
  fieldSubject: string;
  fieldBody: string;
  fieldBodyHint: string;
  fieldPlaceholders: string;
  fieldHint: string;
  fieldOptional: string;
  kindReply: string;
  kindStarter: string;
  types: Record<PlaceholderType, string>;
  palette: string;
  loadFailed: string;
  empty: string;
}

export function templateStrings(s: Settings): TemplateUiStrings {
  return {
    title: s["strings.templates.title"],
    hint: s["strings.templates.hint"],
    pickerEmpty: s["strings.templates.picker.empty"],
    pickerSearch: s["strings.templates.picker.search"],
    pickerYours: s["strings.templates.picker.yours"],
    pickerBuiltin: s["strings.templates.picker.builtin"],
    fillFirst: s["strings.templates.fill_first"],
    typeIt: s["strings.templates.type_it"],
    candidates: s["strings.templates.candidates"],
    noCandidates: s["strings.templates.no_candidates"],
    useEverywhere: s["strings.templates.use_everywhere"],
    changeEverywhere: s["strings.templates.change_everywhere"],
    onlyHere: s["strings.templates.only_here"],
    changeWhere: s["strings.templates.change_where"],
    restore: s["strings.templates.restore"],
    newTemplate: s["strings.templates.new"],
    edit: s["strings.templates.edit"],
    delete: s["strings.templates.delete"],
    deleted: s["strings.templates.deleted"],
    undo: s["strings.templates.undo"],
    save: s["strings.templates.save"],
    cancel: s["strings.templates.cancel"],
    hide: s["strings.templates.hide"],
    show: s["strings.templates.show"],
    hiddenCount: s["strings.templates.hidden_count"],
    export: s["strings.templates.export"],
    import: s["strings.templates.import"],
    exported: s["strings.templates.exported"],
    imported: s["strings.templates.imported"],
    importFailed: s["strings.templates.import_failed"],
    failed: s["strings.templates.failed"],
    invalid: s["strings.templates.invalid"],
    badgeBuiltin: s["strings.templates.badge.builtin"],
    badgeEdited: s["strings.templates.badge.edited"],
    badgeEverywhere: s["strings.templates.badge.everywhere"],
    badgeAgent: s["strings.templates.badge.agent"],
    fieldName: s["strings.templates.field.name"],
    fieldFitsWhen: s["strings.templates.field.fits_when"],
    fieldKind: s["strings.templates.field.kind"],
    fieldSubject: s["strings.templates.field.subject"],
    fieldBody: s["strings.templates.field.body"],
    fieldBodyHint: s["strings.templates.field.body_hint"],
    fieldPlaceholders: s["strings.templates.field.placeholders"],
    fieldHint: s["strings.templates.field.hint"],
    fieldOptional: s["strings.templates.field.optional"],
    kindReply: s["strings.templates.kind.reply"],
    kindStarter: s["strings.templates.kind.starter"],
    types: {
      person: s["strings.templates.type.person"],
      first_name: s["strings.templates.type.first_name"],
      email: s["strings.templates.type.email"],
      date: s["strings.templates.type.date"],
      time: s["strings.templates.type.time"],
      amount: s["strings.templates.type.amount"],
      number: s["strings.templates.type.number"],
      reference: s["strings.templates.type.reference"],
      link: s["strings.templates.type.link"],
      text: s["strings.templates.type.text"],
    },
    palette: s["strings.templates.palette"],
    loadFailed: s["strings.templates.load_failed"],
    empty: s["strings.templates.empty"],
  };
}

/** A string with its {name} holes filled. */
export function fillIn(text: string, values: Record<string, string | number>): string {
  return text.replace(/\{([a-z_]+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
