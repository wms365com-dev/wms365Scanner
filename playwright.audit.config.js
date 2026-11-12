module.exports = {
  testDir: ".",
  testMatch: /audit-billing-finance\.spec\.js/,
  testIgnore: ["**/tmp/**", "**/output/**", "**/outputs/**", "**/node_modules/**"],
  reporter: "line",
  use: {
    browserName: "chromium"
  }
};
