"use strict";

const { main } = require("./read-ranchers-clickship-queue");

main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
});
