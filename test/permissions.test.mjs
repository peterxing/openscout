import assert from "node:assert/strict";
import { test } from "node:test";
import { graphUrl } from "../dist/server/graph.js";
import { isM365ReadOnly } from "../dist/server/m365.js";
import { shellAllowed, summarizePermission } from "../dist/server/permissions.js";

const allow = ["Get-ChildItem", "Get-Content", "Test-Path"];
const shell = (text, ids) => ({ kind: "shell", fullCommandText: text, commands: ids.map((identifier) => ({ identifier, readOnly: false })), hasWriteFileRedirection: false });

test("shell allow-list accepts a plain allow-listed command", () => {
  assert.equal(shellAllowed(shell('Get-ChildItem "C:\\Users\\me\\Documents" -Recurse', ["Get-ChildItem"]), allow), true);
  assert.equal(shellAllowed(shell("Test-Path 'C:\\a b\\c.txt'", ["Test-Path"]), allow), true);
});

test("shell allow-list rejects code execution and chaining", () => {
  const cases = [
    ["Get-ChildItem ([System.Diagnostics.Process]::Start('calc'))", ["Get-ChildItem"]],
    ["Get-ChildItem $(Remove-Item x)", ["Get-ChildItem", "Remove-Item"]],
    ["Get-ChildItem $env:TEMP", ["Get-ChildItem"]],
    ["Get-ChildItem; Remove-Item x", ["Get-ChildItem", "Remove-Item"]],
    ["Get-ChildItem | Remove-Item", ["Get-ChildItem", "Remove-Item"]],
    ["Get-Content x.txt > y.txt", ["Get-Content"]],
    ["Get-ChildItem `", ["Get-ChildItem"]],
    ["Remove-Item x", ["Remove-Item"]],
    ["Get-ChildItemX", ["Get-ChildItemX"]],
  ];
  for (const [text, ids] of cases) assert.equal(shellAllowed(shell(text, ids), allow), false, text);
});

const custom = (toolName, args) => ({ kind: "custom-tool", toolName, toolDescription: "", args });

test("Microsoft 365 writes are high risk and never session-approvable", () => {
  const send = summarizePermission(custom("m365_action", { actionUrl: "/me/sendMail", jsonBody: {} }));
  assert.equal(send.readOnly, false);
  assert.equal(send.risk, "high");
  assert.equal(send.allowSession, false);
  assert.equal(send.title, "Send an email");
  const search = summarizePermission(custom("m365_action", { actionUrl: "/search/query", jsonBody: {} }));
  assert.equal(search.readOnly, true);
  assert.equal(summarizePermission(custom("m365_create", { parentUrl: "/me/events", jsonBody: {} })).title, "Create a calendar event (invites go to any attendees)");
});

test("Microsoft 365 read-only classification", () => {
  assert.equal(isM365ReadOnly("m365_fetch"), true);
  assert.equal(isM365ReadOnly("m365_search"), true);
  assert.equal(isM365ReadOnly("m365_action", { actionUrl: "/me/calendar/getSchedule" }), true);
  assert.equal(isM365ReadOnly("m365_action", { actionUrl: "/me/messages/AAMk=/forward" }), false);
  assert.equal(isM365ReadOnly("m365_action", { actionUrl: "/me/sendMail?x=/search/query" }), false);
  assert.equal(isM365ReadOnly("m365_update"), false);
  assert.equal(isM365ReadOnly("m365_delete"), false);
});

test("Graph paths stay on graph.microsoft.com", () => {
  assert.equal(graphUrl("/me/messages?$top=5").href, "https://graph.microsoft.com/v1.0/me/messages?$top=5");
  assert.equal(graphUrl("/beta/me/profile").href, "https://graph.microsoft.com/beta/me/profile");
  assert.equal(graphUrl('/me/messages?$search="quarterly budget"').search, "?$search=%22quarterly%20budget%22");
  for (const bad of ["https://evil.example/x", "//evil.example/x", "me/messages", "/me\n/messages", ""]) {
    assert.throws(() => graphUrl(bad), undefined, bad);
  }
  assert.equal(graphUrl("/@evil.example/x").origin, "https://graph.microsoft.com");
});

test("automation tools are classified by their effective privilege", () => {
  const ctx = { automationAllowsActions: (id) => (id === "privileged" ? true : id === "plain" ? false : undefined) };
  const sum = (name, args) => summarizePermission(custom(name, args), ctx);
  assert.equal(sum("automation_update", { id: "privileged", name: "x" }).risk, "high", "omitted allowActions keeps privilege");
  assert.equal(sum("automation_update", { id: "plain", allowActions: true }).risk, "high", "escalation");
  assert.equal(sum("automation_update", { id: "privileged", allowActions: false }).readOnly, true, "de-escalation");
  assert.equal(sum("automation_run_now", { id: "privileged" }).risk, "high");
  assert.equal(sum("automation_run_now", { id: "plain" }).readOnly, true);
  assert.equal(sum("automation_create", { name: "x", allowActions: true }).risk, "high");
  assert.equal(sum("automation_delete", { id: "plain" }).readOnly, false);
  assert.equal(sum("skill_save", { name: "x" }).readOnly, false);
});
