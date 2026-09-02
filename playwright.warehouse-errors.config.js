module.exports = {
    testDir: ".",
    testMatch: /warehouse-errors\.visual\.spec\.js/,
    testIgnore: ["**/tmp/**", "**/output/**", "**/outputs/**", "**/node_modules/**"],
    reporter: "line",
    use: {
        browserName: "chromium",
        trace: "retain-on-failure"
    }
};
