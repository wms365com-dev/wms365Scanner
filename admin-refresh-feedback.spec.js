const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

test("product recommendation refresh reports progress, populated, empty, and failure states", () => {
    assert.match(ui, /progressMessage: "Loading the latest local-agent recommendation audit\.\.\."/);
    assert.match(ui, /`Loaded \$\{productRecommendationRecords\.length\} product recommendation/);
    assert.match(ui, /The latest product recommendation audit is available, but it contains no recommendations\./);
    assert.match(ui, /Recommendations could not be loaded\./);
});

test("feedback queue refresh reports progress, populated, empty, and failure states", () => {
    assert.match(ui, /async function refreshFeedbackQueueWithFeedback\(\)/);
    assert.match(ui, /button: ui\.refreshFeedbackQueueBtn/);
    assert.match(ui, /progressMessage: "Loading the latest feedback requests\.\.\."/);
    assert.match(ui, /`Loaded \$\{feedbackRecords\.length\} feedback request/);
    assert.match(ui, /No feedback requests have been submitted yet\./);
    assert.match(ui, /The feedback queue could not be loaded\./);
    assert.match(ui, /refreshFeedbackQueueBtn\?\.addEventListener\("click", refreshFeedbackQueueWithFeedback\)/);
});

test("user feedback wraps the existing read-only refresh without changing admin scope", () => {
    assert.match(ui, /await refreshFeedbackQueue\(true\)/);
    assert.match(ui, /if \(!currentUserIsSuperAdmin\(\)\)/);
    assert.match(ui, /requestJson\("\/api\/admin\/feedback"\)/);
    assert.doesNotMatch(ui, /refreshFeedbackQueueWithFeedback[\s\S]{0,1600}method:\s*"(?:POST|PUT|PATCH|DELETE)"/);
});
