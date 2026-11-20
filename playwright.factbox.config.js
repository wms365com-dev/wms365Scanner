module.exports = {
    testDir: ".",
    testMatch: /factbox-layout\.visual\.spec\.js/,
    testIgnore: ["**/tmp/**", "**/output/**", "**/outputs/**", "**/node_modules/**"],
    reporter: "line",
    use: {
        browserName: "chromium",
        trace: "retain-on-failure"
    }
};
