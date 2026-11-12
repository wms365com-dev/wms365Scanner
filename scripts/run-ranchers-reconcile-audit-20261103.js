require("./reconcile-ranchers-shopify-orders")
    .main(["--audit"])
    .catch((error) => {
        console.error(error.message || String(error));
        process.exitCode = 1;
    });
