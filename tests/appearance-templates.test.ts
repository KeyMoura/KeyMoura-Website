import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { defaultSiteTheme } from "../src/theme/runtime.ts";
import {
  BUILT_IN_PRESETS,
  defaultTemplateAssets,
  normalizeAppearanceTemplateConfig,
  normalizeTemplateName,
  TEMPLATE_NAME_MAX,
  templateNameError,
  templateNameKey,
} from "../src/theme/templates.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const page = read("src/app/staff/appearance/page.tsx");
const listRoute = read("src/app/api/staff/appearance/templates/route.ts");
const itemRoute = read("src/app/api/staff/appearance/templates/[id]/route.ts");
const migration = read("supabase/migrations/20260802010000_appearance_templates.sql");

// --- normalization -------------------------------------------------------

test("a template captures every theme, navbar, and navbar-utility field", () => {
  const config = normalizeAppearanceTemplateConfig({
    primaryColor: "#123456",
    accentColor: "#ABCDEF",
    theme: { ...defaultSiteTheme, navigationUtilityHoverText: "#010203" },
    assets: { logoUrl: "/brand/x.png" },
  });

  assert.equal(config.primaryColor, "#123456");
  assert.equal(config.accentColor, "#abcdef", "colors are stored lowercase");
  assert.equal(config.theme.navigationUtilityHoverText, "#010203");
  for (const key of Object.keys(defaultSiteTheme)) {
    assert.ok(key in config.theme, `template theme is missing ${key}`);
  }
});

test("a template saved before a field existed still normalizes", () => {
  // Simulates an older stored template: no navbar utility colors at all, and
  // the pre-split buttonStyle key instead of primaryButtonStyle.
  const config = normalizeAppearanceTemplateConfig({
    primaryColor: "#111111",
    accentColor: "#222222",
    theme: { background: "#000000", text: "#ffffff", buttonStyle: "outline" },
  });

  assert.equal(config.theme.background, "#000000");
  assert.equal(config.theme.primaryButtonStyle, "outline", "the legacy key is still honored");
  assert.equal(config.theme.navigationUtilityBackground, defaultSiteTheme.navigationUtilityBackground);
  assert.equal(config.theme.navigationUtilityHoverBorder, defaultSiteTheme.navigationUtilityHoverBorder);
  assert.equal(config.theme.shadowStyle, defaultSiteTheme.shadowStyle);
  assert.deepEqual(config.assets, defaultTemplateAssets);
});

test("garbage input becomes a complete, valid template", () => {
  for (const input of [null, undefined, 42, "nope", { theme: "not-an-object" }, {}]) {
    const config = normalizeAppearanceTemplateConfig(input);
    assert.match(config.primaryColor, /^#[0-9a-f]{6}$/);
    assert.match(config.accentColor, /^#[0-9a-f]{6}$/);
    assert.equal(Object.keys(config.theme).length, Object.keys(defaultSiteTheme).length);
  }
});

test("invalid colors fall back instead of being stored", () => {
  const config = normalizeAppearanceTemplateConfig({ primaryColor: "red", accentColor: "#GGGGGG" });
  assert.match(config.primaryColor, /^#[0-9a-f]{6}$/);
  assert.match(config.accentColor, /^#[0-9a-f]{6}$/);
});

test("asset paths must be site-relative or https", () => {
  const config = normalizeAppearanceTemplateConfig({
    assets: {
      logoUrl: "/brand/ok.png",
      wordmarkUrl: "https://cdn.example.com/mark.svg",
      footerLogoUrl: "javascript:alert(1)",
      faviconUrl: "http://insecure.example.com/f.ico",
      appleIconUrl: "   ",
    },
  });

  assert.equal(config.assets.logoUrl, "/brand/ok.png");
  assert.equal(config.assets.wordmarkUrl, "https://cdn.example.com/mark.svg");
  assert.equal(config.assets.footerLogoUrl, defaultTemplateAssets.footerLogoUrl, "script URL rejected");
  assert.equal(config.assets.faviconUrl, defaultTemplateAssets.faviconUrl, "plain http rejected");
  assert.equal(config.assets.appleIconUrl, "", "an explicitly blank value stays blank");
});

// --- names ---------------------------------------------------------------

test("blank names are rejected", () => {
  for (const blank of ["", "   ", "\t\n", null, undefined, 7]) {
    assert.equal(templateNameError(blank), "Give the template a name.");
  }
});

test("names are trimmed, collapsed, and length-capped", () => {
  assert.equal(normalizeTemplateName("  Winter   storefront  "), "Winter storefront");
  assert.equal(normalizeTemplateName("x".repeat(200)).length, TEMPLATE_NAME_MAX);
});

test("confusable duplicate names are refused", () => {
  const existing = ["Winter storefront"];
  assert.equal(templateNameKey("  WINTER   Storefront "), "winter storefront");
  assert.match(String(templateNameError("winter storefront", existing)), /already exists/);
  assert.match(String(templateNameError("  Winter   Storefront  ", existing)), /already exists/);
  assert.equal(templateNameError("Summer storefront", existing), null);
});

// --- API -----------------------------------------------------------------

test("every template endpoint requires the appearance permission", () => {
  for (const [name, source] of [["list route", listRoute], ["item route", itemRoute]] as const) {
    const guards = source.match(/requirePermission\(req, "appearance\.manage"\)/g) ?? [];
    const handlers = source.match(/export async function (GET|POST|PATCH|DELETE)/g) ?? [];
    assert.ok(handlers.length > 0, `${name} defines no handlers`);
    assert.equal(guards.length, handlers.length, `${name}: every handler must check appearance.manage`);
    assert.equal((source.match(/status: 403/g) ?? []).length >= 1, true);
  }
});

test("template storage is never reachable from the browser client", () => {
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.site_appearance_templates from anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete on public\.site_appearance_templates to service_role/);
  assert.ok(!/to anon/.test(migration.replace(/revoke[^;]+;/g, "")), "no privilege is granted to anon");
});

test("the migration is additive and touches nothing that already exists", () => {
  assert.match(migration, /create table if not exists public\.site_appearance_templates/);
  assert.match(migration, /create unique index if not exists/);
  assert.ok(!/drop\s/i.test(migration), "no drop statements");
  assert.ok(!/truncate/i.test(migration), "no truncate");
  assert.ok(!/delete\s+from/i.test(migration), "no deletes");
  assert.ok(!/alter table (?!public\.site_appearance_templates)/i.test(migration), "no other table is altered");
});

test("stored input is normalized server-side before it is written", () => {
  assert.match(listRoute, /normalizeAppearanceTemplateConfig\(body\?\.config\)/);
  assert.match(listRoute, /normalizeTemplateName\(body\?\.name\)/);
  assert.match(itemRoute, /normalizeTemplateName\(body\?\.name\)/);
});

test("duplicate names are reported clearly rather than as a server error", () => {
  assert.equal((listRoute.match(/error\.code === "23505"/g) ?? []).length, 1);
  assert.equal((itemRoute.match(/error\.code === "23505"/g) ?? []).length, 1);
  assert.match(listRoute, /status: 409/);
  assert.match(itemRoute, /status: 409/);
});

test("template changes are audited", () => {
  assert.match(listRoute, /staff\.appearance\.template\.create/);
  assert.match(itemRoute, /staff\.appearance\.template\.rename/);
  assert.match(itemRoute, /staff\.appearance\.template\.delete/);
});

// --- UI wiring -----------------------------------------------------------

test("the Appearance page has its own saved-looks section", () => {
  // Renamed from "Templates": the word describes a file format rather than what
  // the section holds, which is a saved appearance you can try before publishing.
  assert.match(page, /templates: \{ label: "Saved looks"/);
  // The two colour sections collapsed into one searchable "colors", and the
  // choice controls moved to "styles".
  assert.match(page, /"colors" \| "styles" \| "brand" \| "assets" \| "wording" \| "templates"/);
});

test("save, list, apply, rename, and delete are all wired up", () => {
  assert.match(page, /Save as template/);
  assert.match(page, /Apply to preview/);
  assert.match(page, /Rename/);
  assert.match(page, /Delete/);
  assert.match(page, /method: "POST"/);
  assert.match(page, /method: "PATCH"/);
  assert.match(page, /method: "DELETE"/);
});

test("applying a template edits the form and does not publish", () => {
  // applyTemplate must only touch form state; publishing stays behind save().
  const start = page.indexOf("const applyTemplate =");
  const end = page.indexOf("};", start);
  const body = page.slice(start, end);
  assert.ok(!body.includes("save()"), "applying must not publish");
  assert.ok(!body.includes("fetch("), "applying must not call the API");
  assert.match(body, /setForm\(\(current\) => applyTemplateToForm\(current, config\)\)/);
  assert.match(body, /Publish to make it live/);
});

test("applying a template leaves business identity alone", () => {
  const start = page.indexOf("function applyTemplateToForm");
  const body = page.slice(start, page.indexOf("\n}", start));
  for (const field of ["name", "publicUrl", "supportEmail", "description", "copyrightText", "forumLabel"]) {
    assert.ok(!new RegExp(`\\b${field}:`).test(body), `applying a template must not change identity.${field}`);
  }
  assert.match(body, /identity: \{ \.\.\.form\.identity, \.\.\.normalized\.assets \}/);
});

test("the existing publish workflow is preserved", () => {
  for (const control of ["Discard changes", "Publish appearance", "Reset this section", "You have unpublished appearance changes."]) {
    assert.ok(page.includes(control), `missing existing control: ${control}`);
  }
  assert.match(page, /const dirty = JSON\.stringify\(form\) !== JSON\.stringify\(saved\)/);
  assert.match(page, /needs more contrast/, "contrast warnings still run");
});

test("deleting asks for confirmation first", () => {
  assert.match(page, /setConfirmDelete\(template\)/);
  assert.match(page, /aria-labelledby="delete-template-title"/);
  assert.match(page, /Delete “\{confirmDelete\.name\}”\?/);
  assert.match(page, /Keep it/);
  // The destructive action is only reachable from the confirmation dialog.
  assert.match(page, /onClick=\{\(\) => void deleteTemplate\(\)\}/);
  assert.match(page, /if \(!confirmDelete\) return;/);
});

test("built-in presets are distinguished from saved templates", () => {
  assert.match(page, /Built-in presets/);
  assert.match(page, /Built in<\/Badge>/);
  assert.match(page, /Your templates/);
  // Presets are code, so they carry no rename or delete control.
  const presetStart = page.indexOf("Built-in presets");
  const presetEnd = page.indexOf("Your templates");
  const presetBlock = page.slice(presetStart, presetEnd);
  assert.ok(!presetBlock.includes("setRenaming"), "built-in presets must not be renameable");
  assert.ok(!presetBlock.includes("setConfirmDelete"), "built-in presets must not be deletable");
  assert.deepEqual(Object.keys(BUILT_IN_PRESETS), ["KeyMoura", "Ember", "Graphite"]);
});

test("a blank or duplicate name cannot be submitted from the UI", () => {
  assert.match(page, /const canSaveTemplate = Boolean\(normalizeTemplateName\(templateName\)\) && !savedNameConflict/);
  assert.match(page, /disabled=\{!canSaveTemplate\}/);
  assert.match(page, /aria-describedby=\{templateName && savedNameConflict \? "template-name-error" : undefined\}/);
});
