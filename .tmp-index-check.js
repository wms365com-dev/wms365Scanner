
        const LOCAL_STORAGE_KEY = "wms365-scanner-local-v2";
        const LABEL_TOOL_STORAGE_KEY = "wms365-scanner-label-tool-v1";
        const LOCAL_CACHE_ACTIVITY_LIMIT = 30;
        const AUTOCOMPLETE_OPTION_LIMIT = 24;
        const MOBILE_PICKER_ROW_HEIGHT = 68;
        const state = loadState();
        let labelToolState = loadLabelToolState();
        let activeSection = "home";
        let searchMode = "sku";
        let activeSearchSubview = "menu";
        let activeActionSubview = "menu";
        let lastSingleSearch = null;
        let lastMultiSearch = null;
        let currentSearchView = null;
        let editingMasterItem = null;
        let portalAccessRecords = [];
        let portalOrderRecords = [];
        const billingRateDrafts = new Map();
        let syncTimer = null;
        const DESKTOP_SECTION_META = {
            home: {
                title: "Operations Home",
                meta: "Choose the next warehouse task by workflow: inbound, inventory, orders, setup, billing, or reports."
            },
            scan: {
                title: "Inbound",
                meta: "Receive stock, stage inbound inventory, and save the open batch to live stock."
            },
            search: {
                title: "Inventory",
                meta: "Lookup inventory by SKU, UPC, or BIN and review live stock in the active company."
            },
            actions: {
                title: "Adjust & Move",
                meta: "Adjust counts, transfer stock, convert units, and move stock with company-safe controls."
            },
            inventory: {
                title: "Master Data",
                meta: "Maintain companies, BINs, items, portal users, and saved warehouse records."
            },
            orders: {
                title: "Sales Orders",
                meta: "Process company portal orders, print pick tickets and packing slips, and only ship when stock is available."
            },
            reports: {
                title: "Reports & Counts",
                meta: "Run cycle count reporting, utilization, activity review, and inventory worksheet exports."
            },
            billing: {
                title: "Billing",
                meta: "Manage company fee schedules, billing lines, and invoice-ready exports."
            },
            labels: {
                title: "Labels",
                meta: "Build location and pallet labels for the floor and reprint as needed."
            },
            backup: {
                title: "Admin & System",
                meta: "Import, export, backup, restore, and safeguard shared warehouse data."
            }
        };
        const mobileQuery = window.matchMedia("(max-width: 640px)");
        let detectedDeviceExperienceMode = detectDeviceExperienceMode();
        let deviceExperienceMode = detectedDeviceExperienceMode;
        const managedListInputs = [];
        const mobileAutocompleteConfigs = new Map();
        const mobileAutocompleteState = {
            input: null,
            config: null,
            options: [],
            hideTimer: null,
            query: "",
            activeIndex: 0,
            scrollTimer: null
        };

        const ui = {
            tabs: [...document.querySelectorAll(".tab")],
            panels: [...document.querySelectorAll(".panel")],
            quickSectionButtons: [...document.querySelectorAll("[data-jump-section]")],
            mobileNavButtons: [...document.querySelectorAll("[data-mobile-nav]")],
            mobileLinkButtons: [...document.querySelectorAll("[data-mobile-link]")],
            mobileBackButtons: [...document.querySelectorAll("[data-mobile-home]")],
            mobileSectionBackButtons: [...document.querySelectorAll("[data-mobile-section-back]")],
            mobileSubviewButtons: [...document.querySelectorAll("[data-mobile-subview-target]")],
            saveBatchButtons: [...document.querySelectorAll("[data-save-batch]")],
            clearBatchButtons: [...document.querySelectorAll("[data-clear-batch]")],
            desktopPreviewToggle: document.getElementById("desktopPreviewToggle"),
            workspaceSectionTitle: document.getElementById("workspaceSectionTitle"),
            workspaceSectionMeta: document.getElementById("workspaceSectionMeta"),
            workspaceCompanyChip: document.getElementById("workspaceCompanyChip"),
            workspaceSyncChip: document.getElementById("workspaceSyncChip"),
            syncNowBtn: document.getElementById("syncNowBtn"),
            activeCompany: document.getElementById("activeCompany"),
            activeCompanyDisplay: document.getElementById("activeCompanyDisplay"),
            activeCompanyMeta: document.getElementById("activeCompanyMeta"),
            clearActiveCompanyBtn: document.getElementById("clearActiveCompanyBtn"),
            scanAccount: document.getElementById("scanAccount"),
            scanLocation: document.getElementById("scanLocation"),
            scanUpc: document.getElementById("scanUpc"),
            scanSku: document.getElementById("scanSku"),
            scanDescription: document.getElementById("scanDescription"),
            scanQuantity: document.getElementById("scanQuantity"),
            scanTrackingLevel: document.getElementById("scanTrackingLevel"),
            scanHelperTitle: document.getElementById("scanHelperTitle"),
            scanHelperMeta: document.getElementById("scanHelperMeta"),
            scanUom: document.getElementById("scanUom"),
            scanCases: document.getElementById("scanCases"),
            scanImageUrl: document.getElementById("scanImageUrl"),
            scanImageInput: document.getElementById("scanImageInput"),
            scanImagePickBtn: document.getElementById("scanImagePickBtn"),
            scanImageClearBtn: document.getElementById("scanImageClearBtn"),
            scanImagePreviewWrap: document.getElementById("scanImagePreviewWrap"),
            scanImagePreview: document.getElementById("scanImagePreview"),
            scanImagePreviewMeta: document.getElementById("scanImagePreviewMeta"),
            scanMessage: document.getElementById("scanMessage"),
            masterOwnerName: document.getElementById("masterOwnerName"),
            masterOwnerNote: document.getElementById("masterOwnerNote"),
            masterLocationCode: document.getElementById("masterLocationCode"),
            masterLocationNote: document.getElementById("masterLocationNote"),
            masterItemAccount: document.getElementById("masterItemAccount"),
            masterItemSku: document.getElementById("masterItemSku"),
            masterItemUpc: document.getElementById("masterItemUpc"),
            masterItemDescription: document.getElementById("masterItemDescription"),
            masterItemImageUrl: document.getElementById("masterItemImageUrl"),
            masterItemImageInput: document.getElementById("masterItemImageInput"),
            masterItemImagePickBtn: document.getElementById("masterItemImagePickBtn"),
            masterItemImageClearBtn: document.getElementById("masterItemImageClearBtn"),
            masterItemImagePreviewWrap: document.getElementById("masterItemImagePreviewWrap"),
            masterItemImagePreview: document.getElementById("masterItemImagePreview"),
            masterItemImagePreviewMeta: document.getElementById("masterItemImagePreviewMeta"),
            masterItemEditorBanner: document.getElementById("masterItemEditorBanner"),
            masterItemEditorTitle: document.getElementById("masterItemEditorTitle"),
            masterItemEditorMeta: document.getElementById("masterItemEditorMeta"),
            masterItemSubmitBtn: document.getElementById("masterItemSubmitBtn"),
            cancelMasterItemEditBtn: document.getElementById("cancelMasterItemEditBtn"),
            masterItemTrackingLevel: document.getElementById("masterItemTrackingLevel"),
            masterItemUnitsPerCase: document.getElementById("masterItemUnitsPerCase"),
            masterItemEachLength: document.getElementById("masterItemEachLength"),
            masterItemEachWidth: document.getElementById("masterItemEachWidth"),
            masterItemEachHeight: document.getElementById("masterItemEachHeight"),
            masterItemCaseLength: document.getElementById("masterItemCaseLength"),
            masterItemCaseWidth: document.getElementById("masterItemCaseWidth"),
            masterItemCaseHeight: document.getElementById("masterItemCaseHeight"),
            masterFilter: document.getElementById("masterFilter"),
            masterOwnerCount: document.getElementById("masterOwnerCount"),
            masterLocationCount: document.getElementById("masterLocationCount"),
            masterItemCount: document.getElementById("masterItemCount"),
            masterOwnerList: document.getElementById("masterOwnerList"),
            masterOwnerLegalName: document.getElementById("masterOwnerLegalName"),
            masterOwnerCode: document.getElementById("masterOwnerCode"),
            masterOwnerActive: document.getElementById("masterOwnerActive"),
            masterOwnerContactName: document.getElementById("masterOwnerContactName"),
            masterOwnerContactTitle: document.getElementById("masterOwnerContactTitle"),
            masterOwnerEmail: document.getElementById("masterOwnerEmail"),
            masterOwnerPhone: document.getElementById("masterOwnerPhone"),
            masterOwnerMobile: document.getElementById("masterOwnerMobile"),
            masterOwnerWebsite: document.getElementById("masterOwnerWebsite"),
            masterOwnerBillingEmail: document.getElementById("masterOwnerBillingEmail"),
            masterOwnerApEmail: document.getElementById("masterOwnerApEmail"),
            masterOwnerPortalEmail: document.getElementById("masterOwnerPortalEmail"),
            masterOwnerAddress1: document.getElementById("masterOwnerAddress1"),
            masterOwnerAddress2: document.getElementById("masterOwnerAddress2"),
            masterOwnerCity: document.getElementById("masterOwnerCity"),
            masterOwnerState: document.getElementById("masterOwnerState"),
            masterOwnerPostalCode: document.getElementById("masterOwnerPostalCode"),
            masterOwnerCountry: document.getElementById("masterOwnerCountry"),
            masterLocationList: document.getElementById("masterLocationList"),
            masterItemList: document.getElementById("masterItemList"),
            portalAccessAccount: document.getElementById("portalAccessAccount"),
            portalAccessId: document.getElementById("portalAccessId"),
            portalAccessEmail: document.getElementById("portalAccessEmail"),
            portalAccessPassword: document.getElementById("portalAccessPassword"),
            portalAccessActive: document.getElementById("portalAccessActive"),
            portalAccessResetBtn: document.getElementById("portalAccessResetBtn"),
            portalAccessMessage: document.getElementById("portalAccessMessage"),
            portalAccessList: document.getElementById("portalAccessList"),
            portalAccessCount: document.getElementById("portalAccessCount"),
            openPortalBtn: document.getElementById("openPortalBtn"),
            catalogMessage: document.getElementById("catalogMessage"),
            importLocationCsvInput: document.getElementById("importLocationCsvInput"),
            importItemCsvInput: document.getElementById("importItemCsvInput"),
            lastLocationMeta: document.getElementById("lastLocationMeta"),
            batchMeta: document.getElementById("batchMeta"),
            batchEmpty: document.getElementById("batchEmpty"),
            batchTableWrap: document.getElementById("batchTableWrap"),
            batchTableBody: document.getElementById("batchTableBody"),
            searchMessage: document.getElementById("searchMessage"),
            searchBySkuBtn: document.getElementById("searchBySkuBtn"),
            searchByLocationBtn: document.getElementById("searchByLocationBtn"),
            singleSearchLabel: document.getElementById("singleSearchLabel"),
            searchAccount: document.getElementById("searchAccount"),
            singleSearchInput: document.getElementById("singleSearchInput"),
            multiSearchInput: document.getElementById("multiSearchInput"),
            printSingleSearchBtn: document.getElementById("printSingleSearchBtn"),
            printMultiSearchBtn: document.getElementById("printMultiSearchBtn"),
            searchMobileBackBtn: document.getElementById("searchMobileBackBtn"),
            searchFormCard: document.getElementById("searchFormCard"),
            searchResultsCard: document.getElementById("searchResultsCard"),
            mobileSearchResultsBlock: document.getElementById("mobileSearchResultsBlock"),
            mobileSearchResultsContent: document.getElementById("mobileSearchResultsContent"),
            searchResultsContent: document.getElementById("searchResultsContent"),
            actionMessage: document.getElementById("actionMessage"),
            adjustAccount: document.getElementById("adjustAccount"),
            adjustLocation: document.getElementById("adjustLocation"),
            adjustSku: document.getElementById("adjustSku"),
            adjustQuantity: document.getElementById("adjustQuantity"),
            transferAccount: document.getElementById("transferAccount"),
            transferFrom: document.getElementById("transferFrom"),
            transferTo: document.getElementById("transferTo"),
            transferSku: document.getElementById("transferSku"),
            transferQty: document.getElementById("transferQty"),
            convertAccount: document.getElementById("convertAccount"),
            convertFrom: document.getElementById("convertFrom"),
            convertTo: document.getElementById("convertTo"),
            convertSourceSku: document.getElementById("convertSourceSku"),
            convertSourceQty: document.getElementById("convertSourceQty"),
            convertTargetSku: document.getElementById("convertTargetSku"),
            convertPreview: document.getElementById("convertPreview"),
            moveAccount: document.getElementById("moveAccount"),
            moveFrom: document.getElementById("moveFrom"),
            moveTo: document.getElementById("moveTo"),
            activityList: document.getElementById("activityList"),
            inventoryFilter: document.getElementById("inventoryFilter"),
            inventoryMeta: document.getElementById("inventoryMeta"),
            inventoryEmpty: document.getElementById("inventoryEmpty"),
            inventoryTableWrap: document.getElementById("inventoryTableWrap"),
            inventoryTableBody: document.getElementById("inventoryTableBody"),
            reportFilter: document.getElementById("reportFilter"),
            reportMessage: document.getElementById("reportMessage"),
            reportLocationsCount: document.getElementById("reportLocationsCount"),
            reportItemsCount: document.getElementById("reportItemsCount"),
            reportUnitsCount: document.getElementById("reportUnitsCount"),
            reportMasterBinsCount: document.getElementById("reportMasterBinsCount"),
            locationReportMeta: document.getElementById("locationReportMeta"),
            locationReportEmpty: document.getElementById("locationReportEmpty"),
            locationReportWrap: document.getElementById("locationReportWrap"),
            locationReportBody: document.getElementById("locationReportBody"),
            itemReportMeta: document.getElementById("itemReportMeta"),
            itemReportEmpty: document.getElementById("itemReportEmpty"),
            itemReportWrap: document.getElementById("itemReportWrap"),
            itemReportBody: document.getElementById("itemReportBody"),
            vendorInventoryReportMeta: document.getElementById("vendorInventoryReportMeta"),
            vendorInventoryReportEmpty: document.getElementById("vendorInventoryReportEmpty"),
            vendorInventoryReportWrap: document.getElementById("vendorInventoryReportWrap"),
            vendorInventoryReportBody: document.getElementById("vendorInventoryReportBody"),
            ownerReportMeta: document.getElementById("ownerReportMeta"),
            ownerReportEmpty: document.getElementById("ownerReportEmpty"),
            ownerReportWrap: document.getElementById("ownerReportWrap"),
            ownerReportBody: document.getElementById("ownerReportBody"),
            reportOwner: document.getElementById("reportOwner"),
            reportOwnersCount: document.getElementById("reportOwnersCount"),
            reportPalletLocationsCount: document.getElementById("reportPalletLocationsCount"),
            reportPalletsCount: document.getElementById("reportPalletsCount"),
            billingOwner: document.getElementById("billingOwner"),
            billingFeeFilter: document.getElementById("billingFeeFilter"),
            billingStorageMonth: document.getElementById("billingStorageMonth"),
            billingMessage: document.getElementById("billingMessage"),
            billingActiveFeeCount: document.getElementById("billingActiveFeeCount"),
            billingOpenLineCount: document.getElementById("billingOpenLineCount"),
            billingOpenAmount: document.getElementById("billingOpenAmount"),
            billingFilteredAmount: document.getElementById("billingFilteredAmount"),
            billingRatesMeta: document.getElementById("billingRatesMeta"),
            billingRatesEmpty: document.getElementById("billingRatesEmpty"),
            billingRatesWrap: document.getElementById("billingRatesWrap"),
            billingRatesBody: document.getElementById("billingRatesBody"),
            billingManualFeeCode: document.getElementById("billingManualFeeCode"),
            billingManualDate: document.getElementById("billingManualDate"),
            billingManualQuantity: document.getElementById("billingManualQuantity"),
            billingManualRate: document.getElementById("billingManualRate"),
            billingManualReference: document.getElementById("billingManualReference"),
            billingManualNote: document.getElementById("billingManualNote"),
            billingManualFeeMeta: document.getElementById("billingManualFeeMeta"),
            billingEventsMeta: document.getElementById("billingEventsMeta"),
            billingStatusFilter: document.getElementById("billingStatusFilter"),
            billingFromDate: document.getElementById("billingFromDate"),
            billingToDate: document.getElementById("billingToDate"),
            billingEventFilter: document.getElementById("billingEventFilter"),
            billingInvoiceNumber: document.getElementById("billingInvoiceNumber"),
            billingEventsEmpty: document.getElementById("billingEventsEmpty"),
            billingEventsWrap: document.getElementById("billingEventsWrap"),
            billingEventsBody: document.getElementById("billingEventsBody"),
            portalOrdersMeta: document.getElementById("portalOrdersMeta"),
            portalOrdersMessage: document.getElementById("portalOrdersMessage"),
            portalOrdersList: document.getElementById("portalOrdersList"),
            portalOrderStatusFilter: document.getElementById("portalOrderStatusFilter"),
            portalOrderSearch: document.getElementById("portalOrderSearch"),
            clearPortalOrderFiltersBtn: document.getElementById("clearPortalOrderFiltersBtn"),
            salesOrderReleasedCount: document.getElementById("salesOrderReleasedCount"),
            salesOrderPickedCount: document.getElementById("salesOrderPickedCount"),
            salesOrderStagedCount: document.getElementById("salesOrderStagedCount"),
            salesOrderShippedCount: document.getElementById("salesOrderShippedCount"),
            summaryLocations: document.getElementById("summaryLocations"),
            summaryOwners: document.getElementById("summaryOwners"),
            summarySkus: document.getElementById("summarySkus"),
            summaryUnits: document.getElementById("summaryUnits"),
            summarySaved: document.getElementById("summarySaved"),
            backupMessage: document.getElementById("backupMessage"),
            importFileInput: document.getElementById("importFileInput"),
            labelRackInput: document.getElementById("labelRackInput"),
            labelBinInput: document.getElementById("labelBinInput"),
            labelLevelInput: document.getElementById("labelLevelInput"),
            labelSideInput: document.getElementById("labelSideInput"),
            labelBulkInput: document.getElementById("labelBulkInput"),
            labelLibraryFilterInput: document.getElementById("labelLibraryFilterInput"),
            labelModeButtons: [...document.querySelectorAll("[data-label-mode]")],
            locationLabelTool: document.getElementById("locationLabelTool"),
            locationLabelLibraryTool: document.getElementById("locationLabelLibraryTool"),
            palletLabelTool: document.getElementById("palletLabelTool"),
            palletLabelCode: document.getElementById("palletLabelCode"),
            palletLabelAccount: document.getElementById("palletLabelAccount"),
            palletLabelSku: document.getElementById("palletLabelSku"),
            palletLabelDescription: document.getElementById("palletLabelDescription"),
            palletLabelCases: document.getElementById("palletLabelCases"),
            palletLabelDate: document.getElementById("palletLabelDate"),
            palletLabelLocation: document.getElementById("palletLabelLocation"),
            palletLabelSkuList: document.getElementById("palletLabelSkuList"),
            labelPreviewTitle: document.getElementById("labelPreviewTitle"),
            labelPreviewLead: document.getElementById("labelPreviewLead"),
            labelLibraryMeta: document.getElementById("labelLibraryMeta"),
            labelPreviewMeta: document.getElementById("labelPreviewMeta"),
            labelsMessage: document.getElementById("labelsMessage"),
            labelsPreviewEmpty: document.getElementById("labelsPreviewEmpty"),
            labelsPreviewGrid: document.getElementById("labelsPreviewGrid"),
            printLabelsBtn: document.getElementById("printLabelsBtn"),
            exportLabelCodesBtn: document.getElementById("exportLabelCodesBtn"),
            clearLabelsBtn: document.getElementById("clearLabelsBtn"),
            locationList: document.getElementById("locationList"),
            ownerList: document.getElementById("ownerList"),
            scanUpcList: document.getElementById("scanUpcList"),
            scanSkuList: document.getElementById("scanSkuList"),
            skuList: document.getElementById("skuList"),
            adjustLocationList: document.getElementById("adjustLocationList"),
            transferFromList: document.getElementById("transferFromList"),
            transferToList: document.getElementById("transferToList"),
            moveFromList: document.getElementById("moveFromList"),
            moveToList: document.getElementById("moveToList"),
            adjustSkuList: document.getElementById("adjustSkuList"),
            transferSkuList: document.getElementById("transferSkuList"),
            convertFromList: document.getElementById("convertFromList"),
            convertToList: document.getElementById("convertToList"),
            convertSourceSkuList: document.getElementById("convertSourceSkuList"),
            convertTargetSkuList: document.getElementById("convertTargetSkuList"),
            mobileAutocomplete: document.getElementById("mobileAutocomplete"),
            mobilePickerKicker: document.getElementById("mobilePickerKicker"),
            mobilePickerTitle: document.getElementById("mobilePickerTitle"),
            mobilePickerDoneBtn: document.getElementById("mobilePickerDoneBtn"),
            mobilePickerSearchInput: document.getElementById("mobilePickerSearchInput"),
            mobilePickerSelected: document.getElementById("mobilePickerSelected"),
            mobilePickerOptions: document.getElementById("mobilePickerOptions"),
            statUnits: document.getElementById("statUnits"),
            statLines: document.getElementById("statLines"),
            statLocations: document.getElementById("statLocations"),
            statBatch: document.getElementById("statBatch")
        };

        [...document.querySelectorAll("input[list]")].forEach((input) => {
            input.dataset.desktopList = input.getAttribute("list") || "";
            managedListInputs.push(input);
        });

        init();

        function init() {
            applyDeviceExperienceMode();
            ui.desktopPreviewToggle?.addEventListener("click", toggleDesktopPreviewMode);
            ui.syncNowBtn?.addEventListener("click", () => {
                syncServerState(true).catch(() => {});
            });
            ["change", "blur"].forEach((eventName) => ui.activeCompany?.addEventListener(eventName, () => setActiveCompany(ui.activeCompany.value, { force: true })));
            ui.activeCompany?.addEventListener("keydown", (event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                setActiveCompany(ui.activeCompany.value, { force: true });
            });
            ui.clearActiveCompanyBtn?.addEventListener("click", () => {
                clearActiveCompany();
                ui.activeCompany?.focus();
            });
            [
                ui.scanAccount,
                ui.searchAccount,
                ui.adjustAccount,
                ui.transferAccount,
                ui.convertAccount,
                ui.moveAccount,
                ui.reportOwner,
                ui.billingOwner,
                ui.palletLabelAccount,
                ui.portalAccessAccount,
                ui.masterItemAccount
            ].filter(Boolean).forEach((input) => {
                ["change", "blur"].forEach((eventName) => input.addEventListener(eventName, () => commitCompanyContextInput(input)));
                input.addEventListener("keydown", (event) => {
                    if (event.key !== "Enter" || input.readOnly || input.disabled) return;
                    event.preventDefault();
                    commitCompanyContextInput(input);
                });
            });
            ui.tabs.forEach((tab) => tab.addEventListener("click", () => setSection(tab.dataset.section)));
            ui.quickSectionButtons.forEach((button) => button.addEventListener("click", () => setSection(button.dataset.jumpSection)));
            ui.mobileNavButtons.forEach((button) => button.addEventListener("click", () => {
                if (button.dataset.mobileLabelMode) {
                    setLabelToolMode(button.dataset.mobileLabelMode);
                }
                setSection(button.dataset.mobileNav);
            }));
            ui.mobileLinkButtons.forEach((button) => button.addEventListener("click", () => {
                const target = button.dataset.mobileLink;
                if (target) {
                    window.location.href = target;
                }
            }));
            ui.mobileBackButtons.forEach((button) => button.addEventListener("click", () => setSection("mobile-home")));
            ui.mobileSectionBackButtons.forEach((button) => button.addEventListener("click", () => handleMobileSectionBack(button.dataset.mobileSectionBack)));
            ui.mobileSubviewButtons.forEach((button) => button.addEventListener("click", () => {
                const group = button.dataset.mobileSubviewBtnGroup;
                const target = button.dataset.mobileSubviewTarget;
                if (group && target) setMobileSubview(group, target);
            }));
            document.getElementById("masterOwnerForm").addEventListener("submit", saveMasterOwner);
            document.getElementById("scanForm").addEventListener("submit", addToBatch);
            document.getElementById("calcQtyBtn").addEventListener("click", () => calculateQuantity(true));
            document.getElementById("useLastLocationBtn").addEventListener("click", useLastLocation);
            ui.saveBatchButtons.forEach((button) => button.addEventListener("click", saveBatchToInventory));
            ui.clearBatchButtons.forEach((button) => button.addEventListener("click", clearBatch));
            ui.batchTableBody.addEventListener("click", onBatchTableClick);
            [ui.scanAccount, ui.scanLocation, ui.scanUpc, ui.scanSku, ui.scanQuantity].forEach((el) => el.addEventListener("keydown", scanEnterFlow));
            [ui.scanSku, ui.scanUpc, ui.scanAccount].forEach((el) => {
                el.addEventListener("change", syncScanFieldsFromCatalog);
                el.addEventListener("blur", syncScanFieldsFromCatalog);
            });
            ui.scanAccount?.addEventListener("input", syncScanItemSelectors);
            ui.activeCompany?.addEventListener("change", () => setActiveCompany(ui.activeCompany.value, { force: true }));
            ui.clearActiveCompanyBtn?.addEventListener("click", clearActiveCompany);
            ui.scanTrackingLevel.addEventListener("change", updateScanTrackingUi);
            ui.scanDescription.addEventListener("input", () => updateScanTrackingUi(findMasterItemByCode(ui.scanSku.value || ui.scanUpc.value, ui.scanAccount.value)));
            ui.scanImagePickBtn.addEventListener("click", () => ui.scanImageInput.click());
            ui.scanImageClearBtn.addEventListener("click", () => clearImageField({
                urlInput: ui.scanImageUrl,
                previewWrap: ui.scanImagePreviewWrap,
                previewImg: ui.scanImagePreview,
                previewMeta: ui.scanImagePreviewMeta,
                clearBtn: ui.scanImageClearBtn,
                defaultMeta: "Compressed photo preview"
            }));
            ui.scanImageInput.addEventListener("change", (event) => handleImageInputChange(event, {
                urlInput: ui.scanImageUrl,
                previewWrap: ui.scanImagePreviewWrap,
                previewImg: ui.scanImagePreview,
                previewMeta: ui.scanImagePreviewMeta,
                clearBtn: ui.scanImageClearBtn,
                messageElement: ui.scanMessage,
                defaultMeta: "Compressed photo preview"
            }));
            ["change", "blur"].forEach((eventName) => ui.scanImageUrl.addEventListener(eventName, () => refreshImagePreview({
                urlInput: ui.scanImageUrl,
                previewWrap: ui.scanImagePreviewWrap,
                previewImg: ui.scanImagePreview,
                previewMeta: ui.scanImagePreviewMeta,
                clearBtn: ui.scanImageClearBtn,
                defaultMeta: "Compressed photo preview"
            })));

            document.getElementById("masterLocationForm").addEventListener("submit", saveMasterLocation);
            document.getElementById("masterItemForm").addEventListener("submit", saveMasterItem);
            document.getElementById("portalAccessForm").addEventListener("submit", savePortalAccess);
            ui.portalAccessResetBtn?.addEventListener("click", () => resetPortalAccessForm({ keepCompany: true }));
            document.getElementById("loadVendorToPortalBtn").addEventListener("click", loadVendorToPortalAccess);
            document.getElementById("loadVendorToBillingBtn").addEventListener("click", loadVendorToBilling);
            ui.cancelMasterItemEditBtn.addEventListener("click", cancelMasterItemEdit);
            ui.openPortalBtn.addEventListener("click", () => window.open("/portal", "_blank", "noopener"));
            ui.masterFilter.addEventListener("input", renderMasterLibrary);
            ui.masterOwnerList.addEventListener("click", onMasterOwnerListClick);
            ui.masterLocationList.addEventListener("click", onMasterLocationListClick);
            ui.masterItemList.addEventListener("click", onMasterItemListClick);
            ui.portalAccessList.addEventListener("click", onPortalAccessListClick);
            ui.portalOrdersList.addEventListener("click", onPortalOrdersListClick);
            ui.portalOrderStatusFilter?.addEventListener("change", () => renderPortalOrdersList());
            ui.portalOrderSearch?.addEventListener("input", () => renderPortalOrdersList());
            ui.clearPortalOrderFiltersBtn?.addEventListener("click", () => {
                if (ui.portalOrderStatusFilter) ui.portalOrderStatusFilter.value = "";
                if (ui.portalOrderSearch) ui.portalOrderSearch.value = "";
                renderPortalOrdersList();
            });
            ui.masterItemImagePickBtn.addEventListener("click", () => ui.masterItemImageInput.click());
            ui.masterItemImageClearBtn.addEventListener("click", () => clearImageField({
                urlInput: ui.masterItemImageUrl,
                previewWrap: ui.masterItemImagePreviewWrap,
                previewImg: ui.masterItemImagePreview,
                previewMeta: ui.masterItemImagePreviewMeta,
                clearBtn: ui.masterItemImageClearBtn,
                defaultMeta: "Compressed item photo preview"
            }));
            ui.masterItemImageInput.addEventListener("change", (event) => handleImageInputChange(event, {
                urlInput: ui.masterItemImageUrl,
                previewWrap: ui.masterItemImagePreviewWrap,
                previewImg: ui.masterItemImagePreview,
                previewMeta: ui.masterItemImagePreviewMeta,
                clearBtn: ui.masterItemImageClearBtn,
                messageElement: ui.catalogMessage,
                defaultMeta: "Compressed item photo preview"
            }));
            ["change", "blur"].forEach((eventName) => ui.masterItemImageUrl.addEventListener(eventName, () => refreshImagePreview({
                urlInput: ui.masterItemImageUrl,
                previewWrap: ui.masterItemImagePreviewWrap,
                previewImg: ui.masterItemImagePreview,
                previewMeta: ui.masterItemImagePreviewMeta,
                clearBtn: ui.masterItemImageClearBtn,
                defaultMeta: "Compressed item photo preview"
            })));
            document.getElementById("exportLocationCsvBtn").addEventListener("click", exportLocationCsv);
            document.getElementById("importLocationCsvBtn").addEventListener("click", () => ui.importLocationCsvInput.click());
            ui.importLocationCsvInput.addEventListener("change", importLocationCsv);
            document.getElementById("exportItemCsvBtn").addEventListener("click", exportItemCsv);
            document.getElementById("importItemCsvBtn").addEventListener("click", () => ui.importItemCsvInput.click());
            ui.importItemCsvInput.addEventListener("change", importItemCsv);

            ui.searchBySkuBtn.addEventListener("click", () => setSearchMode("sku"));
            ui.searchByLocationBtn.addEventListener("click", () => setSearchMode("location"));
            document.getElementById("singleSearchForm").addEventListener("submit", (e) => { e.preventDefault(); performSingleSearch(ui.singleSearchInput.value); });
            document.getElementById("multiSearchForm").addEventListener("submit", (e) => { e.preventDefault(); performMultiSearch(ui.multiSearchInput.value); });
            ui.printSingleSearchBtn.addEventListener("click", printSingleSearch);
            ui.printMultiSearchBtn.addEventListener("click", printMultiSearch);

            document.getElementById("removeQtyBtn").addEventListener("click", removeQuantity);
            document.getElementById("deleteLineBtn").addEventListener("click", deleteLine);
            document.getElementById("transferForm").addEventListener("submit", transferQuantity);
            document.getElementById("convertForm").addEventListener("submit", convertInventoryItems);
            document.getElementById("moveForm").addEventListener("submit", moveAllItems);
            [
                ui.adjustAccount, ui.adjustLocation,
                ui.transferAccount, ui.transferFrom, ui.transferTo,
                ui.convertAccount, ui.convertFrom, ui.convertTo, ui.convertSourceSku, ui.convertSourceQty, ui.convertTargetSku,
                ui.moveAccount, ui.moveFrom, ui.moveTo
            ].forEach((input) => {
                ["input", "change", "blur"].forEach((eventName) => input.addEventListener(eventName, syncActionItemSelectors));
            });

            ui.inventoryFilter.addEventListener("input", () => renderInventory(ui.inventoryFilter.value));
            document.getElementById("clearInventoryFilterBtn").addEventListener("click", () => {
                ui.inventoryFilter.value = "";
                renderInventory("");
                ui.inventoryFilter.focus();
            });
            ui.reportFilter.addEventListener("input", () => renderReports(ui.reportFilter.value));
            ui.reportOwner.addEventListener("input", () => renderReports(ui.reportFilter.value));
            document.getElementById("clearReportFilterBtn").addEventListener("click", () => {
                ui.reportFilter.value = "";
                ui.reportOwner.value = getActiveCompany() || "";
                renderReports("");
                (getActiveCompany() ? ui.reportFilter : ui.reportOwner).focus();
            });
            document.getElementById("exportOwnerReportBtn").addEventListener("click", exportOwnerReportCsv);
            document.getElementById("exportLocationReportBtn").addEventListener("click", exportLocationReportCsv);
            document.getElementById("exportItemReportBtn").addEventListener("click", exportItemReportCsv);
            document.getElementById("exportVendorInventoryReportBtn").addEventListener("click", exportVendorInventoryReportCsv);
            document.getElementById("printReportsBtn").addEventListener("click", printReports);
            ui.billingOwner.addEventListener("input", onBillingOwnerInput);
            ui.billingFeeFilter.addEventListener("input", renderBilling);
            ui.billingStatusFilter.addEventListener("change", renderBilling);
            ui.billingFromDate.addEventListener("change", renderBilling);
            ui.billingToDate.addEventListener("change", renderBilling);
            ui.billingEventFilter.addEventListener("input", renderBilling);
            ui.billingRatesBody.addEventListener("input", onBillingRateDraftChange);
            ui.billingRatesBody.addEventListener("change", onBillingRateDraftChange);
            ui.billingManualFeeCode.addEventListener("change", syncManualBillingFeeDefaults);
            document.getElementById("saveBillingRatesBtn").addEventListener("click", saveBillingRates);
            document.getElementById("billingManualForm").addEventListener("submit", saveManualBillingEvent);
            document.getElementById("generateStorageBillingBtn").addEventListener("click", generateStorageBilling);
            document.getElementById("exportBillingZohoBtn").addEventListener("click", exportBillingZohoCsv);
            document.getElementById("exportBillingDetailBtn").addEventListener("click", exportBillingDetailCsv);
            document.getElementById("markBillingInvoicedBtn").addEventListener("click", markFilteredBillingInvoiced);

            document.getElementById("exportJsonBtn").addEventListener("click", exportJson);
            document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
            document.getElementById("importJsonBtn").addEventListener("click", () => ui.importFileInput.click());
            ui.importFileInput.addEventListener("change", importJson);
            document.getElementById("addSingleLabelBtn").addEventListener("click", addSingleLocationLabel);
            document.getElementById("addLabelPairBtn").addEventListener("click", addLocationLabelPair);
            document.getElementById("addBulkLabelsBtn").addEventListener("click", addBulkLocationLabels);
            document.getElementById("addSavedLabelsBtn").addEventListener("click", addSavedLocationLabels);
            document.getElementById("clearLabelsBtn").addEventListener("click", clearLocationLabels);
            document.getElementById("palletLabelForm").addEventListener("submit", (event) => savePalletLabelRecord(event, { printAfterSave: false }));
            document.getElementById("loadPalletLabelBtn").addEventListener("click", loadPalletLabelRecord);
            document.getElementById("newPalletLabelBtn").addEventListener("click", resetPalletLabelForm);
            document.getElementById("savePrintPalletLabelBtn").addEventListener("click", (event) => savePalletLabelRecord(event, { printAfterSave: true }));
            document.getElementById("clearPalletLabelsBtn").addEventListener("click", clearPalletLabels);
            document.getElementById("printLabelsBtn").addEventListener("click", printLocationLabels);
            document.getElementById("exportLabelCodesBtn").addEventListener("click", exportLocationLabelCodesCsv);
            document.getElementById("labelToolForm").addEventListener("submit", (event) => {
                event.preventDefault();
                addSingleLocationLabel();
            });
            ui.labelModeButtons.forEach((button) => button.addEventListener("click", () => setLabelToolMode(button.dataset.labelMode)));
            [ui.labelRackInput, ui.labelBinInput, ui.labelLevelInput, ui.labelSideInput, ui.labelBulkInput, ui.labelLibraryFilterInput]
                .forEach((input) => input?.addEventListener("input", persistLocationLabelDraft));
            [ui.palletLabelCode, ui.palletLabelAccount, ui.palletLabelSku, ui.palletLabelDescription, ui.palletLabelCases, ui.palletLabelDate, ui.palletLabelLocation]
                .forEach((input) => input?.addEventListener("input", persistPalletLabelDraft));
            ui.palletLabelAccount?.addEventListener("input", () => {
                syncPalletLabelSkuOptions();
                syncPalletLabelCatalogFields();
            });
            ui.palletLabelDescription?.addEventListener("input", () => {
                ui.palletLabelDescription.dataset.autofilled = "false";
            });
            [ui.palletLabelAccount, ui.palletLabelSku].forEach((input) => {
                input?.addEventListener("change", syncPalletLabelCatalogFields);
                input?.addEventListener("blur", syncPalletLabelCatalogFields);
            });

            ui.activeCompany.value = state.preferences.activeCompany || "";
            ui.scanAccount.value = state.preferences.activeCompany || "";
            ui.scanLocation.value = state.preferences.lastLocation || "";
            ui.masterItemAccount.value = state.preferences.activeCompany || "";
            ui.labelRackInput.value = labelToolState.rack;
            ui.labelBinInput.value = labelToolState.bin;
            ui.labelLevelInput.value = String(labelToolState.level);
            ui.labelSideInput.value = labelToolState.side;
            ui.labelBulkInput.value = labelToolState.bulk;
            ui.labelLibraryFilterInput.value = labelToolState.filter;
            ui.palletLabelCode.value = labelToolState.palletCode || "";
            ui.palletLabelAccount.value = labelToolState.palletAccount || state.preferences.activeCompany || "";
            ui.palletLabelSku.value = labelToolState.palletSku || "";
            ui.palletLabelDescription.value = labelToolState.palletDescription || "";
            ui.palletLabelCases.value = labelToolState.palletCases || "";
            ui.palletLabelDate.value = labelToolState.palletDate || todayInputValue();
            ui.palletLabelLocation.value = labelToolState.palletLocation || "";
            ui.billingOwner.value = state.preferences.activeCompany || "";
            ui.billingStorageMonth.value = new Date().toISOString().slice(0, 7);
            ui.billingManualDate.value = todayInputValue();
            syncActiveCompanyFields(getActiveCompany(), { force: true });
            updateActiveCompanyUi();
            setSearchMode("sku");
            setMobileSubview("search", isMobileView() ? "menu" : "single");
            setMobileSubview("actions", isMobileView() ? "menu" : "adjust");
            updateScanTrackingUi();
            syncScanItemSelectors();
            syncPalletLabelSkuOptions();
            syncPalletLabelCatalogFields();
            setLabelToolMode(labelToolState.mode || "location");
            renderAll();
            setSection(isMobileView() ? "mobile-home" : "home");
            syncServerState(false).catch(() => {});
            refreshPortalAccessList().catch(() => {});
            refreshPortalOrdersList().catch(() => {});
            syncTimer = window.setInterval(() => {
                if (document.visibilityState === "visible") {
                    syncServerState(true).catch(() => {});
                    refreshPortalOrdersList(true).catch(() => {});
                }
            }, 30000);
            window.addEventListener("focus", () => {
                syncServerState(true).catch(() => {});
                refreshPortalOrdersList(true).catch(() => {});
            });
            mobileQuery.addEventListener("change", handleViewportChange);
            window.addEventListener("resize", handleViewportChange);
            window.addEventListener("orientationchange", handleViewportChange);
            initMobileAutocomplete();
        }

        function isDesktopMobilePreviewEnabled() {
            return detectedDeviceExperienceMode !== "mobile" && !!state.preferences.desktopMobilePreview;
        }

        function syncDesktopPreviewToggle() {
            if (!ui.desktopPreviewToggle) return;
            const canPreview = detectedDeviceExperienceMode !== "mobile";
            ui.desktopPreviewToggle.hidden = !canPreview;
            if (!canPreview) return;
            const previewOn = isDesktopMobilePreviewEnabled();
            ui.desktopPreviewToggle.textContent = previewOn ? "Desktop View" : "Mobile Preview";
            ui.desktopPreviewToggle.setAttribute("aria-pressed", String(previewOn));
        }

        function toggleDesktopPreviewMode() {
            if (detectedDeviceExperienceMode === "mobile") return;
            state.preferences.desktopMobilePreview = !state.preferences.desktopMobilePreview;
            saveState();
            applyDeviceExperienceMode();
            if (isMobileView()) {
                setSection("mobile-home");
                return;
            }
            setSection(activeSection === "mobile-home" ? "home" : activeSection);
        }

        function setSection(section) {
            hideMobileAutocomplete();
            if (!isMobileView() && section === "mobile-home") {
                section = "home";
            }
            activeSection = section;
            ui.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.section === section));
            ui.panels.forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === section));
            if (section === "mobile-home") {
                scrollCurrentViewTop();
                return;
            }
            if (section === "scan") {
                if (!isMobileView()) focusScanStart();
                else scrollCurrentViewTop();
            }
            if (section === "search") {
                if (isMobileView()) {
                    setMobileSubview("search", "menu");
                    scrollCurrentViewTop();
                }
                else ui.singleSearchInput.focus();
            }
            if (section === "actions" && isMobileView()) {
                setMobileSubview("actions", "menu");
                scrollCurrentViewTop();
            }
            if (section === "labels" && isMobileView()) {
                scrollCurrentViewTop();
            }
            updateMobileSearchResultsVisibility();
            updateWorkspaceCommandBar();
            if (section === "inventory" && !isMobileView()) ui.inventoryFilter.focus();
            if (section === "reports" && !isMobileView()) ui.reportFilter.focus();
            if (section === "billing" && !isMobileView()) (getActiveCompany() ? ui.billingFeeFilter : ui.billingOwner).focus();
            syncServerState(true).catch(() => {});
            if (section === "orders") {
                refreshPortalOrdersList(true).catch(() => {});
            }
        }

        function handleViewportChange() {
            hideMobileAutocomplete();
            applyDeviceExperienceMode();
            updateActiveCompanyUi();
            if (!isMobileView() && activeSection === "mobile-home") {
                setSection("home");
            }
            if (isMobileView()) {
                if (activeSection === "search") setMobileSubview("search", "menu");
                if (activeSection === "actions") setMobileSubview("actions", "menu");
            }
            updateMobileSearchResultsVisibility();
        }

        function isMobileView() {
            return deviceExperienceMode === "mobile";
        }

        function normalizeCompanyContextValue(value) {
            const normalized = norm(value || "");
            if (!normalized) return "";
            const blocked = new Set([
                "all companies",
                "all company",
                "all accounts",
                "all account",
                "select company",
                "select company…",
                "choose a company",
                "choose company",
                "choose a 3pl company",
                "choose 3pl company"
            ]);
            return blocked.has(normalized) ? "" : normalized;
        }

        function getActiveCompany() {
            const chipText = String(ui.workspaceCompanyChip?.textContent || "").replace(/^\s*Company\s*:\s*/i, "").trim();
            const displayText = String(ui.activeCompanyDisplay?.textContent || "").trim();
            return normalizeCompanyContextValue(
                ui.activeCompany?.value
                || state.preferences.activeCompany
                || chipText
                || displayText
                || ""
            );
        }

        function getScopedCompanyValue(rawValue = "") {
            const normalizedRaw = norm(rawValue);
            if (isMobileView() && normalizedRaw) return normalizedRaw;
            return getActiveCompany() || normalizedRaw;
        }

        function getCompanyBoundInputs() {
            return [
                ui.scanAccount,
                ui.searchAccount,
                ui.adjustAccount,
                ui.transferAccount,
                ui.moveAccount,
                ui.reportOwner,
                ui.billingOwner,
                ui.palletLabelAccount,
                ui.portalAccessAccount
            ].filter(Boolean);
        }

        function updateActiveCompanyUi() {
            const company = getActiveCompany();
            if (ui.activeCompanyDisplay) {
                ui.activeCompanyDisplay.textContent = company || "All Companies";
            }
            if (ui.activeCompanyMeta) {
                ui.activeCompanyMeta.textContent = company
                    ? `Warehouse work is currently scoped to ${company}.`
                    : "Choose a company to scope receiving, lookup, adjustments, reports, billing, labels, and portal review.";
            }
            if (ui.clearActiveCompanyBtn) {
                ui.clearActiveCompanyBtn.disabled = !company;
            }
            updateCompanyBoundUi();
            updateWorkspaceCommandBar();
        }

        function updateCompanyBoundUi() {
            const company = getActiveCompany();
            const lockDesktopContext = !!company && !isMobileView();
            [
                ...getCompanyBoundInputs(),
                ui.masterItemAccount
            ].filter(Boolean).forEach((input) => {
                if (!input.dataset.companyPlaceholder) {
                    input.dataset.companyPlaceholder = input.placeholder || "";
                }
                const field = input.closest(".field");
                const lockInput = lockDesktopContext && (!editingMasterItem || input !== ui.masterItemAccount);
                input.readOnly = lockInput;
                input.classList.toggle("company-bound-input-locked", lockInput);
                input.title = lockInput
                    ? `Using active company ${company}. Change it in the header to switch the warehouse context.`
                    : "";
                if (field) {
                    field.classList.toggle("company-bound-field-locked", lockInput);
                    field.classList.toggle("desktop-company-field-hidden", lockDesktopContext && input !== ui.portalAccessAccount && input !== ui.masterItemAccount);
                }
                if (lockInput && company) {
                    input.value = company;
                } else if (!input.value) {
                    input.placeholder = input.dataset.companyPlaceholder || "";
                }
            });
        }

        function syncActiveCompanyFields(company = getActiveCompany(), { force = false } = {}) {
            const normalized = norm(company);
            getCompanyBoundInputs().forEach((input) => {
                if (!input) return;
                if (!normalized) {
                    if (force) input.value = "";
                    return;
                }
                if (force || !norm(input.value) || norm(input.value) !== normalized) {
                    input.value = normalized;
                }
            });

            if (!editingMasterItem && ui.masterItemAccount) {
                if (!normalized) {
                    if (force) ui.masterItemAccount.value = "";
                } else if (force || !norm(ui.masterItemAccount.value) || norm(ui.masterItemAccount.value) !== normalized) {
                    ui.masterItemAccount.value = normalized;
                }
            }

            if (ui.palletLabelAccount) {
                labelToolState.palletAccount = normalized;
                saveLabelToolState();
            }
        }

        function refreshCompanyScopedUi() {
            renderAll();
            renderPortalAccessList();
            renderPortalOrdersList();
            currentSearchView = null;
            lastSingleSearch = null;
            lastMultiSearch = null;
            setSearchResultsMarkup(
                `<p class="empty">${getActiveCompany() ? `Working in ${esc(getActiveCompany())}. Run a search to load current results.` : "Choose a company and run a search to load results."}</p>`,
                `<p class="empty">${getActiveCompany() ? `Working in ${esc(getActiveCompany())}. Run a search to load current results.` : "Choose a company and run a search to load results."}</p>`
            );
            updateActiveCompanyUi();
        }

        function setActiveCompany(value, { force = false, persist = true, rerender = true } = {}) {
            const normalized = normalizeCompanyContextValue(value);
            const previous = getActiveCompany();
            state.preferences.activeCompany = normalized;
            state.preferences.lastAccount = normalized || "";
            if (ui.activeCompany) {
                ui.activeCompany.value = normalized;
            }
            syncActiveCompanyFields(normalized, { force: force || normalized !== previous });
            updateActiveCompanyUi();
            if (persist) saveState();
            if (rerender) refreshCompanyScopedUi();
            refreshPortalOrdersList(true).catch(() => {});
        }

        function clearActiveCompany() {
            setActiveCompany("", { force: true });
        }

        function commitCompanyContextInput(input) {
            if (!input || input.readOnly || input.disabled) return;
            const nextCompany = norm(input.value);
            const currentCompany = getActiveCompany();
            if (nextCompany === currentCompany) return;
            if (!nextCompany && !currentCompany) return;
            setActiveCompany(nextCompany, { force: true });
        }

        function updateWorkspaceCommandBar() {
            const definition = DESKTOP_SECTION_META[activeSection] || DESKTOP_SECTION_META.scan;
            const company = getActiveCompany();
            const syncStamp = state.meta.lastChangedAt || state.meta.serverSyncedAt || state.meta.localCacheAt || "";
            if (ui.workspaceSectionTitle) {
                ui.workspaceSectionTitle.textContent = definition.title;
            }
            if (ui.workspaceSectionMeta) {
                ui.workspaceSectionMeta.textContent = definition.meta;
            }
            if (ui.workspaceCompanyChip) {
                ui.workspaceCompanyChip.textContent = company ? `Company: ${company}` : "Choose a company";
            }
            if (ui.workspaceSyncChip) {
                ui.workspaceSyncChip.textContent = syncStamp ? `Server Sync: ${formatDate(syncStamp)}` : "Server Sync: Not yet synced";
            }
        }

        function detectDeviceExperienceMode() {
            const userAgent = String(navigator.userAgent || "");
            const userAgentMobile = navigator.userAgentData?.mobile === true;
            const phoneLikeAgent = /iphone|ipod|android.+mobile|windows phone|blackberry|opera mini|mobile/i.test(userAgent);
            const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
            const touchPoints = Number(navigator.maxTouchPoints || 0);
            const viewportMax = Math.max(window.innerWidth || 0, window.innerHeight || 0);
            const viewportMin = Math.min(window.innerWidth || 0, window.innerHeight || 0);
            const screenMax = Math.max(window.screen?.width || 0, window.screen?.height || 0, viewportMax);
            const screenMin = Math.min(
                window.screen?.width || viewportMin || 0,
                window.screen?.height || viewportMin || 0,
                viewportMin || 0
            );
            const compactTouchHandset = coarsePointer && touchPoints > 0 && screenMax <= 950 && screenMin <= 500;
            return (userAgentMobile || phoneLikeAgent || compactTouchHandset) ? "mobile" : "desktop";
        }

        function applyDeviceExperienceMode() {
            detectedDeviceExperienceMode = detectDeviceExperienceMode();
            deviceExperienceMode = isDesktopMobilePreviewEnabled() ? "mobile" : detectedDeviceExperienceMode;
            const useMobileClass = deviceExperienceMode === "mobile";
            document.body.classList.toggle("device-mobile", useMobileClass);
            document.body.classList.toggle("preview-mobile-desktop", isDesktopMobilePreviewEnabled());
            applyManagedInputLists();
            syncMobilePickerInputs();
            syncDesktopPreviewToggle();
        }

        function applyManagedInputLists() {
            managedListInputs.forEach((input) => {
                const listId = input.dataset.desktopList || "";
                if (isMobileView() || !listId) input.removeAttribute("list");
                else input.setAttribute("list", listId);
            });
        }

        function syncMobilePickerInputs() {
            mobileAutocompleteConfigs.forEach((config) => {
                const input = config?.input;
                if (!input) return;
                input.dataset.mobilePicker = "true";
                input.readOnly = isMobileView();
                input.setAttribute("autocomplete", "off");
                input.setAttribute("autocorrect", "off");
                input.setAttribute("autocapitalize", "off");
                input.setAttribute("spellcheck", "false");
                if (isMobileView()) input.setAttribute("inputmode", "none");
                else input.removeAttribute("inputmode");
            });
        }

        function scrollCurrentViewTop() {
            if (!isMobileView()) return;
            window.requestAnimationFrame(() => {
                const activePanel = ui.panels.find((panel) => panel.classList.contains("active"));
                const activeBody = activePanel?.querySelector(".mobile-screen-body");
                if (activeBody && typeof activeBody.scrollTo === "function") {
                    activeBody.scrollTo({ top: 0, left: 0, behavior: "auto" });
                }
                if (activePanel && typeof activePanel.scrollTo === "function") {
                    activePanel.scrollTo({ top: 0, left: 0, behavior: "auto" });
                }
                window.scrollTo({ top: 0, left: 0, behavior: "auto" });
            });
        }

        function setSearchMode(mode) {
            searchMode = mode;
            ui.searchBySkuBtn.classList.toggle("active", mode === "sku");
            ui.searchByLocationBtn.classList.toggle("active", mode === "location");
            ui.singleSearchLabel.textContent = mode === "sku" ? "SKU or UPC" : "Location";
            ui.singleSearchInput.placeholder = mode === "sku" ? "Scan SKU or UPC" : "Scan or enter location";
            ui.singleSearchInput.dataset.desktopList = mode === "sku" ? "skuList" : "locationList";
            applyManagedInputLists();
            refreshMobileAutocomplete();
        }

        function setMobileSubview(group, view) {
            hideMobileAutocomplete();
            if (group === "search") activeSearchSubview = view;
            if (group === "actions") activeActionSubview = view;

            document.querySelectorAll(`[data-mobile-subview-menu-group="${group}"]`).forEach((element) => {
                element.classList.toggle("active", view === "menu");
            });
            document.querySelectorAll(`[data-mobile-subview-card-group="${group}"]`).forEach((element) => {
                element.classList.toggle("active", view !== "menu");
            });
            document.querySelectorAll(`[data-mobile-subview-group="${group}"]`).forEach((element) => {
                element.classList.toggle("active", element.dataset.mobileSubview === view);
            });
            ui.mobileSubviewButtons
                .filter((button) => button.dataset.mobileSubviewBtnGroup === group)
                .forEach((button) => {
                    const isActive = button.dataset.mobileSubviewTarget === view;
                    button.classList.toggle("active", isActive);
                    button.classList.toggle("ghost", !isActive);
                });

            updateMobileBackButtons();
            updateMobileSearchResultsVisibility();

            if (isMobileView()) {
                scrollCurrentViewTop();
                return;
            }
            if (view === "menu") return;
            if (group === "search") {
                if (view === "multi") ui.multiSearchInput.focus();
                else ui.singleSearchInput.focus();
            }
            if (group === "actions") {
                if (view === "transfer") ui.transferAccount.focus();
                else if (view === "convert") ui.convertAccount.focus();
                else if (view === "move") ui.moveAccount.focus();
                else ui.adjustAccount.focus();
            }
        }

        function updateMobileSearchResultsVisibility() {
            if (!ui.searchResultsCard || !ui.mobileSearchResultsBlock) return;
            const showMobileResults = isMobileView() && activeSection === "search" && activeSearchSubview !== "menu" && !!currentSearchView;
            ui.searchResultsCard.classList.toggle("hidden", isMobileView());
            ui.mobileSearchResultsBlock.classList.toggle("hidden", !showMobileResults);
        }

        function updateMobileBackButtons() {
            if (ui.searchMobileBackBtn) {
                ui.searchMobileBackBtn.textContent = activeSearchSubview === "menu" ? "Back To Menu" : "Back To Search Tools";
            }
            const actionsBackBtn = document.getElementById("actionsMobileBackBtn");
            if (actionsBackBtn) {
                actionsBackBtn.textContent = activeActionSubview === "menu" ? "Back To Menu" : "Back To Action Tools";
            }
        }

        function handleMobileSectionBack(group) {
            if (group === "search") {
                if (activeSearchSubview === "menu") setSection("mobile-home");
                else setMobileSubview("search", "menu");
                return;
            }
            if (group === "actions") {
                if (activeActionSubview === "menu") setSection("mobile-home");
                else setMobileSubview("actions", "menu");
            }
        }

        function initMobileAutocomplete() {
            if (!ui.mobileAutocomplete) return;

            [ui.scanAccount, ui.searchAccount, ui.adjustAccount, ui.transferAccount, ui.convertAccount, ui.moveAccount, ui.reportOwner, ui.masterOwnerName, ui.masterItemAccount, ui.palletLabelAccount]
                .forEach((input) => registerMobileAutocomplete(input, {
                    getSuggestions: (query) => getOwnerSuggestions(query),
                    onSelect: (option, currentInput) => {
                        if (currentInput !== ui.masterOwnerName) {
                            setActiveCompany(option.value, { force: true, rerender: false });
                        }
                        if (currentInput === ui.scanAccount) {
                            syncScanFieldsFromCatalog();
                            if (isMobileView()) {
                                if (!(ui.scanLocation.value || "").trim()) queueMobilePicker(ui.scanLocation);
                                else if (!(ui.scanSku.value || "").trim() && !(ui.scanUpc.value || "").trim()) queueMobilePicker(ui.scanSku);
                            } else if (!(ui.scanLocation.value || "").trim()) ui.scanLocation.focus();
                            else if (!(ui.scanSku.value || "").trim() && !(ui.scanUpc.value || "").trim()) ui.scanUpc.focus();
                            return false;
                        }
                        return true;
                    }
                }));
            [ui.scanLocation, ui.masterLocationCode, ui.palletLabelLocation]
                .forEach((input) => registerMobileAutocomplete(input, {
                    getSuggestions: (query) => getLocationSuggestions(query),
                    onSelect: (option, currentInput) => {
                        if (currentInput === ui.scanLocation) {
                            state.preferences.lastLocation = option.value;
                            saveState();
                            if (isMobileView()) {
                                if (!(ui.scanAccount.value || "").trim()) queueMobilePicker(ui.scanAccount);
                                else queueMobilePicker(ui.scanSku);
                            } else if (!(ui.scanAccount.value || "").trim()) ui.scanAccount.focus();
                            else ui.scanUpc.focus();
                            return false;
                        }
                        return true;
                    }
                }));
            registerMobileAutocomplete(ui.palletLabelSku, {
                getSuggestions: (query) => getItemSuggestions(query, ui.palletLabelAccount.value, { preferUpc: false }),
                allowCustom: () => !!norm(ui.palletLabelAccount.value),
                getEmptyState: () => norm(ui.palletLabelAccount.value)
                    ? "No SKUs are saved for this company yet."
                    : "Choose company first so the pallet SKU list stays company-safe.",
                onSelect: () => {
                    syncPalletLabelCatalogFields();
                    return true;
                }
            });
            registerMobileAutocomplete(ui.adjustLocation, {
                getSuggestions: (query) => getOwnerScopedLocationSuggestions(query, ui.adjustAccount.value, { mode: "source" }),
                onSelect: () => {
                    syncActionItemSelectors();
                    return true;
                }
            });
            registerMobileAutocomplete(ui.transferFrom, {
                getSuggestions: (query) => getOwnerScopedLocationSuggestions(query, ui.transferAccount.value, { mode: "source" }),
                onSelect: () => {
                    syncActionItemSelectors();
                    return true;
                }
            });
            registerMobileAutocomplete(ui.transferTo, {
                getSuggestions: (query) => getOwnerScopedLocationSuggestions(query, ui.transferAccount.value, {
                    mode: "destination",
                    excludeLocation: ui.transferFrom.value
                }),
                onSelect: () => {
                    syncActionItemSelectors();
                    return true;
                }
            });
            registerMobileAutocomplete(ui.convertFrom, {
                getSuggestions: (query) => getOwnerScopedLocationSuggestions(query, ui.convertAccount.value, { mode: "source" }),
                onSelect: () => {
                    if (!norm(ui.convertTo.value) && norm(ui.convertFrom.value)) {
                        ui.convertTo.value = norm(ui.convertFrom.value);
                    }
                    syncActionItemSelectors();
                    return true;
                }
            });
            registerMobileAutocomplete(ui.convertTo, {
                getSuggestions: (query) => getOwnerScopedLocationSuggestions(query, ui.convertAccount.value, { mode: "destination" }),
                onSelect: () => {
                    syncActionItemSelectors();
                    return true;
                }
            });
            registerMobileAutocomplete(ui.moveFrom, {
                getSuggestions: (query) => getOwnerScopedLocationSuggestions(query, ui.moveAccount.value, { mode: "source" }),
                onSelect: () => {
                    syncActionItemSelectors();
                    return true;
                }
            });
            registerMobileAutocomplete(ui.moveTo, {
                getSuggestions: (query) => getOwnerScopedLocationSuggestions(query, ui.moveAccount.value, {
                    mode: "destination",
                    excludeLocation: ui.moveFrom.value
                }),
                onSelect: () => {
                    syncActionItemSelectors();
                    return true;
                }
            });
            registerMobileAutocomplete(ui.scanUpc, {
                getSuggestions: (query) => norm(ui.scanAccount.value)
                    ? getItemSuggestions(query, ui.scanAccount.value, { preferUpc: true })
                    : [],
                allowCustom: () => !!norm(ui.scanAccount.value),
                getEmptyState: () => norm(ui.scanAccount.value)
                    ? "No UPCs are saved for this company yet."
                    : "Choose company first. Then the UPC wheel will only show that company's items.",
                onSelect: (option) => {
                    applyMobileScanItem(option);
                    return false;
                }
            });
            registerMobileAutocomplete(ui.scanSku, {
                getSuggestions: (query) => norm(ui.scanAccount.value)
                    ? getItemSuggestions(query, ui.scanAccount.value, { preferUpc: false })
                    : [],
                allowCustom: () => !!norm(ui.scanAccount.value),
                getEmptyState: () => norm(ui.scanAccount.value)
                    ? "No SKUs are saved for this company yet."
                    : "Choose company first. Then the SKU wheel will only show that company's items.",
                onSelect: (option) => {
                    applyMobileScanItem(option);
                    return false;
                }
            });
            registerMobileAutocomplete(ui.singleSearchInput, {
                getSuggestions: (query, input) => input.dataset.desktopList === "locationList"
                    ? getLocationSuggestions(query)
                    : getItemSuggestions(query, ui.searchAccount.value, { preferUpc: looksNumeric(query) }),
                onSelect: (option, input) => {
                    if (input.dataset.desktopList === "locationList") return true;
                    if (!norm(ui.searchAccount.value) && option.accountName) {
                        setActiveCompany(option.accountName, { force: true, rerender: false });
                        ui.searchAccount.value = option.accountName;
                    }
                    return true;
                }
            });
            registerMobileAutocomplete(ui.adjustSku, {
                getSuggestions: (query) => getLocationScopedItemSuggestions(query, ui.adjustAccount.value, ui.adjustLocation.value, { preferUpc: looksNumeric(query) }),
                onSelect: (option) => {
                    if (!norm(ui.adjustAccount.value) && option.accountName) ui.adjustAccount.value = option.accountName;
                    return true;
                }
            });
            registerMobileAutocomplete(ui.transferSku, {
                getSuggestions: (query) => getLocationScopedItemSuggestions(query, ui.transferAccount.value, ui.transferFrom.value, { preferUpc: looksNumeric(query) }),
                onSelect: (option) => {
                    if (!norm(ui.transferAccount.value) && option.accountName) ui.transferAccount.value = option.accountName;
                    return true;
                }
            });
            registerMobileAutocomplete(ui.convertSourceSku, {
                getSuggestions: (query) => getLocationScopedItemSuggestions(query, ui.convertAccount.value, ui.convertFrom.value, { preferUpc: looksNumeric(query) }),
                onSelect: (option) => {
                    if (!norm(ui.convertAccount.value) && option.accountName) ui.convertAccount.value = option.accountName;
                    syncActionItemSelectors();
                    return true;
                }
            });
            registerMobileAutocomplete(ui.convertTargetSku, {
                getSuggestions: (query) => getConvertibleTargetSuggestions(query, ui.convertAccount.value, ui.convertSourceSku.value, { preferUpc: looksNumeric(query) }),
                onSelect: (option) => {
                    if (!norm(ui.convertAccount.value) && option.accountName) ui.convertAccount.value = option.accountName;
                    syncActionItemSelectors();
                    return true;
                }
            });
            registerMobileAutocomplete(ui.masterItemSku, {
                getSuggestions: (query) => getItemSuggestions(query, ui.masterItemAccount.value, { preferUpc: false }),
                onSelect: (option) => {
                    if (!norm(ui.masterItemAccount.value) && option.accountName) ui.masterItemAccount.value = option.accountName;
                    return true;
                }
            });
            registerMobileAutocomplete(ui.masterItemUpc, {
                getSuggestions: (query) => getItemSuggestions(query, ui.masterItemAccount.value, { preferUpc: true }),
                onSelect: (option) => {
                    if (!norm(ui.masterItemAccount.value) && option.accountName) ui.masterItemAccount.value = option.accountName;
                    return true;
                }
            });

            syncMobilePickerInputs();
            ui.mobileAutocomplete.addEventListener("pointerdown", (event) => {
                if (
                    event.target.closest("[data-mobile-autocomplete-index]") ||
                    event.target.closest("#mobilePickerDoneBtn")
                ) {
                    event.preventDefault();
                }
            });
            ui.mobileAutocomplete.addEventListener("click", onMobileAutocompleteClick);
            if (ui.mobilePickerSearchInput) {
                ui.mobilePickerSearchInput.addEventListener("input", () => {
                    mobileAutocompleteState.query = ui.mobilePickerSearchInput.value || "";
                    renderMobileAutocompleteOptions({ preserveActive: false });
                });
                ui.mobilePickerSearchInput.addEventListener("keydown", (event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        commitMobileAutocompleteSelection(getActiveMobileAutocompleteOption() || buildTypedMobileAutocompleteOption(), { dispatchFallback: true });
                    } else if (event.key === "Escape") {
                        event.preventDefault();
                        hideMobileAutocomplete();
                    }
                });
            }
            if (ui.mobilePickerOptions) {
                ui.mobilePickerOptions.addEventListener("scroll", handleMobilePickerScroll, { passive: true });
            }
            window.addEventListener("resize", () => refreshMobileAutocomplete());
        }

        function registerMobileAutocomplete(input, config) {
            if (!input) return;
            mobileAutocompleteConfigs.set(input.id, { ...config, input });
            input.dataset.mobilePicker = "true";
            ["focus", "click"].forEach((eventName) => input.addEventListener(eventName, () => {
                if (!isMobileView()) return;
                openMobileAutocomplete(input);
            }));
            input.addEventListener("keydown", (event) => {
                if (!isMobileView()) return;
                if (!["Enter", "ArrowDown", " "].includes(event.key)) return;
                event.preventDefault();
                openMobileAutocomplete(input);
            });
        }

        function queueMobilePicker(input) {
            if (!input) return;
            window.requestAnimationFrame(() => {
                if (!isMobileView()) {
                    input.focus();
                    return;
                }
                openMobileAutocomplete(input);
            });
        }

        function openMobileAutocomplete(input, { query = null, focusSearch = false } = {}) {
            if (!isMobileView()) return hideMobileAutocomplete();
            mobileAutocompleteState.query = typeof query === "string" ? query : "";
            refreshMobileAutocomplete(input, { focusSearch });
        }

        function refreshMobileAutocomplete(input = mobileAutocompleteState.input, { focusSearch = false } = {}) {
            clearMobileAutocompleteHideTimer();
            if (!isMobileView()) return hideMobileAutocomplete();
            if (!input) return hideMobileAutocomplete();
            const config = mobileAutocompleteConfigs.get(input.id);
            if (!config || !document.body.contains(input) || input.offsetParent === null) return hideMobileAutocomplete();

            mobileAutocompleteState.input = input;
            mobileAutocompleteState.config = config;
            if (typeof mobileAutocompleteState.query !== "string") {
                mobileAutocompleteState.query = "";
            }
            if (ui.mobilePickerTitle) ui.mobilePickerTitle.textContent = getMobilePickerTitle(input);
            if (ui.mobilePickerKicker) ui.mobilePickerKicker.textContent = getMobilePickerKicker(input);
            if (ui.mobilePickerSearchInput) {
                if (ui.mobilePickerSearchInput.value !== mobileAutocompleteState.query) {
                    ui.mobilePickerSearchInput.value = mobileAutocompleteState.query;
                }
                ui.mobilePickerSearchInput.placeholder = `Type to filter ${getMobilePickerTitle(input).replace(/^Choose\s+/i, "").toLowerCase()}`;
            }
            ui.mobileAutocomplete.classList.remove("hidden");
            renderMobileAutocompleteOptions({ preserveActive: true });
            if (focusSearch && ui.mobilePickerSearchInput) {
                window.requestAnimationFrame(() => {
                    ui.mobilePickerSearchInput.focus({ preventScroll: true });
                    ui.mobilePickerSearchInput.select();
                });
            }
        }

        function getMobilePickerKicker(input) {
            if (input === ui.scanAccount || input === ui.searchAccount || input === ui.adjustAccount || input === ui.transferAccount || input === ui.convertAccount || input === ui.moveAccount || input === ui.masterOwnerName || input === ui.masterItemAccount || input === ui.reportOwner) {
                return "Company Picker";
            }
            if (input === ui.scanLocation || input === ui.adjustLocation || input === ui.transferFrom || input === ui.transferTo || input === ui.convertFrom || input === ui.convertTo || input === ui.moveFrom || input === ui.moveTo || input === ui.masterLocationCode) {
                return "Location Picker";
            }
            return "Item Picker";
        }

        function getMobilePickerTitle(input) {
            const field = input?.closest(".field");
            const label = field?.querySelector("span")?.textContent?.trim();
            return label ? `Choose ${label}` : "Choose a value";
        }

        function buildTypedMobileAutocompleteOption() {
            const rawValue = String(ui.mobilePickerSearchInput?.value || mobileAutocompleteState.query || "").trim();
            const input = mobileAutocompleteState.input;
            const config = mobileAutocompleteState.config;
            const allowCustom = typeof config?.allowCustom === "function"
                ? !!config.allowCustom(input, config)
                : config?.allowCustom !== false;
            if (!allowCustom) return null;
            if (!rawValue) return null;
            const label = input ? getMobilePickerTitle(input).replace(/^Choose\s+/i, "") : "value";
            return {
                value: rawValue,
                title: rawValue,
                meta: `Use typed ${label.toLowerCase()}.`,
                searchText: rawValue,
                custom: true
            };
        }

        function getMobileAutocompleteInitialIndex(options, preferredValue = "") {
            if (!options.length) return 0;
            const normalizedPreferred = norm(preferredValue);
            if (normalizedPreferred) {
                const directIndex = options.findIndex((option) => norm(option.value) === normalizedPreferred);
                if (directIndex >= 0) return directIndex;
            }
            return 0;
        }

        function getActiveMobileAutocompleteOption() {
            return mobileAutocompleteState.options[mobileAutocompleteState.activeIndex] || null;
        }

        function updateMobilePickerSelected(option = getActiveMobileAutocompleteOption()) {
            if (!ui.mobilePickerSelected) return;
            if (!option?.value) {
                ui.mobilePickerSelected.classList.add("hidden");
                ui.mobilePickerSelected.innerHTML = "";
                return;
            }
            ui.mobilePickerSelected.classList.remove("hidden");
            ui.mobilePickerSelected.innerHTML = `
                <strong>Selected</strong>
                <span>${esc(option.title || option.value)}${option.meta ? ` | ${esc(option.meta)}` : ""}</span>
            `;
        }

        function syncMobilePickerActiveClasses() {
            if (!ui.mobilePickerOptions) return;
            const buttons = [...ui.mobilePickerOptions.querySelectorAll("[data-mobile-autocomplete-index]")];
            buttons.forEach((button) => {
                const index = Number(button.dataset.mobileAutocompleteIndex);
                const distance = Math.abs(index - mobileAutocompleteState.activeIndex);
                button.classList.toggle("selected", distance === 0);
                button.classList.toggle("near", distance === 1);
            });
            updateMobilePickerSelected();
        }

        function setMobileAutocompleteActiveIndex(index, { scroll = false, behavior = "smooth" } = {}) {
            const maxIndex = Math.max(0, mobileAutocompleteState.options.length - 1);
            mobileAutocompleteState.activeIndex = Math.max(0, Math.min(index, maxIndex));
            syncMobilePickerActiveClasses();
            if (!scroll || !ui.mobilePickerOptions) return;
            ui.mobilePickerOptions.scrollTo({
                top: mobileAutocompleteState.activeIndex * MOBILE_PICKER_ROW_HEIGHT,
                left: 0,
                behavior
            });
        }

        function handleMobilePickerScroll() {
            if (!ui.mobilePickerOptions || !mobileAutocompleteState.options.length) return;
            const nextIndex = Math.max(
                0,
                Math.min(
                    mobileAutocompleteState.options.length - 1,
                    Math.round(ui.mobilePickerOptions.scrollTop / MOBILE_PICKER_ROW_HEIGHT)
                )
            );
            if (nextIndex !== mobileAutocompleteState.activeIndex) {
                mobileAutocompleteState.activeIndex = nextIndex;
                syncMobilePickerActiveClasses();
            }
            if (mobileAutocompleteState.scrollTimer) {
                window.clearTimeout(mobileAutocompleteState.scrollTimer);
            }
            mobileAutocompleteState.scrollTimer = window.setTimeout(() => {
                if (!ui.mobilePickerOptions || !mobileAutocompleteState.options.length) return;
                ui.mobilePickerOptions.scrollTo({
                    top: mobileAutocompleteState.activeIndex * MOBILE_PICKER_ROW_HEIGHT,
                    left: 0,
                    behavior: "smooth"
                });
            }, 90);
        }

        function renderMobileAutocompleteOptions({ preserveActive = false } = {}) {
            const input = mobileAutocompleteState.input;
            const config = mobileAutocompleteState.config;
            if (!input || !config || !ui.mobilePickerOptions) return hideMobileAutocomplete();

            const rawQuery = String(mobileAutocompleteState.query || "");
            const normalizedQuery = norm(rawQuery);
            let options = (config.getSuggestions ? config.getSuggestions(normalizedQuery, input) : []).slice(0, AUTOCOMPLETE_OPTION_LIMIT);
            const previousActiveValue = preserveActive ? getActiveMobileAutocompleteOption()?.value || "" : "";
            const typedOption = buildTypedMobileAutocompleteOption();
            const hasExactMatch = typedOption && options.some((option) => norm(option.value) === norm(typedOption.value));
            if (typedOption && !hasExactMatch) {
                options = [typedOption, ...options].slice(0, AUTOCOMPLETE_OPTION_LIMIT);
            }

            mobileAutocompleteState.options = options;
            mobileAutocompleteState.activeIndex = getMobileAutocompleteInitialIndex(
                options,
                previousActiveValue || input.value || rawQuery
            );

            if (!options.length) {
                const emptyMessage = typeof config.getEmptyState === "function"
                    ? String(config.getEmptyState(input, normalizedQuery) || "").trim()
                    : "";
                ui.mobilePickerOptions.innerHTML = `
                    <div class="mobile-picker-empty">
                        ${esc(emptyMessage || "Scroll is ready once saved values exist. You can also type a new value above and tap Done.")}
                    </div>
                `;
                updateMobilePickerSelected(buildTypedMobileAutocompleteOption());
                return;
            }

            ui.mobilePickerOptions.innerHTML = options.map((option, index) => `
                <button
                    class="mobile-picker-option ${index === mobileAutocompleteState.activeIndex ? "selected" : ""}"
                    type="button"
                    data-mobile-autocomplete-index="${index}"
                >
                    <span class="mobile-picker-option-title">${esc(option.title || option.value)}</span>
                    ${option.meta ? `<span class="mobile-picker-option-meta">${esc(option.meta)}</span>` : ""}
                </button>
            `).join("");
            window.requestAnimationFrame(() => {
                setMobileAutocompleteActiveIndex(mobileAutocompleteState.activeIndex, { scroll: true, behavior: "auto" });
            });
        }

        function scheduleHideMobileAutocomplete() {
            clearMobileAutocompleteHideTimer();
        }

        function clearMobileAutocompleteHideTimer() {
            if (mobileAutocompleteState.hideTimer) {
                window.clearTimeout(mobileAutocompleteState.hideTimer);
                mobileAutocompleteState.hideTimer = null;
            }
        }

        function hideMobileAutocomplete() {
            clearMobileAutocompleteHideTimer();
            mobileAutocompleteState.input = null;
            mobileAutocompleteState.config = null;
            mobileAutocompleteState.options = [];
            mobileAutocompleteState.query = "";
            mobileAutocompleteState.activeIndex = 0;
            if (mobileAutocompleteState.scrollTimer) {
                window.clearTimeout(mobileAutocompleteState.scrollTimer);
                mobileAutocompleteState.scrollTimer = null;
            }
            if (!ui.mobileAutocomplete) return;
            ui.mobileAutocomplete.classList.add("hidden");
            if (ui.mobilePickerSearchInput) ui.mobilePickerSearchInput.value = "";
            if (ui.mobilePickerOptions) ui.mobilePickerOptions.innerHTML = "";
            if (ui.mobilePickerSelected) {
                ui.mobilePickerSelected.classList.add("hidden");
                ui.mobilePickerSelected.innerHTML = "";
            }
        }

        function commitMobileAutocompleteSelection(option, { dispatchFallback = false } = {}) {
            const input = mobileAutocompleteState.input;
            const config = mobileAutocompleteState.config;
            if (!input || !config || !option?.value) return;

            input.value = option.value;
            hideMobileAutocomplete();
            const shouldDispatch = typeof config.onSelect === "function" ? config.onSelect(option, input, config) : dispatchFallback;
            if (shouldDispatch) {
                input.dispatchEvent(new Event("change", { bubbles: true }));
            }
        }

        function onMobileAutocompleteClick(event) {
            if (event.target === ui.mobileAutocomplete) {
                hideMobileAutocomplete();
                return;
            }
            if (event.target.closest("#mobilePickerDoneBtn")) {
                const option = getActiveMobileAutocompleteOption() || buildTypedMobileAutocompleteOption();
                if (option) commitMobileAutocompleteSelection(option, { dispatchFallback: true });
                else hideMobileAutocomplete();
                return;
            }
            const optionButton = event.target.closest("[data-mobile-autocomplete-index]");
            if (!optionButton) return;
            const option = mobileAutocompleteState.options[Number(optionButton.dataset.mobileAutocompleteIndex)];
            if (!option) return;
            setMobileAutocompleteActiveIndex(Number(optionButton.dataset.mobileAutocompleteIndex), { scroll: true, behavior: "smooth" });
            commitMobileAutocompleteSelection(option, { dispatchFallback: true });
        }

        function applyMobileScanItem(option) {
            const record = option?.item;
            if (!record) return;
            if (record.itemId) {
                fillScanFromMasterItem(record.itemId, { silent: true });
                return;
            }
            ui.scanAccount.value = record.accountName || ui.scanAccount.value;
            state.preferences.lastAccount = ui.scanAccount.value;
            saveState();
            ui.scanSku.value = record.sku || ui.scanSku.value;
            ui.scanUpc.value = record.upc || ui.scanUpc.value;
            ui.scanDescription.value = record.description || ui.scanDescription.value;
            updateScanTrackingUi(record.item || null);
            ui.scanQuantity.focus();
        }

        function getOwnerSuggestions(query) {
            const ownerMap = new Map();
            (state.masters.ownerRecords || []).forEach((owner) => {
                ownerMap.set(owner.name, {
                    value: owner.name,
                    title: owner.name,
                    meta: owner.note || "",
                    searchText: [owner.name, owner.note || ""].filter(Boolean).join(" | ")
                });
            });
            getOwnerOptions().forEach((owner) => {
                if (!ownerMap.has(owner)) {
                    ownerMap.set(owner, {
                        value: owner,
                        title: owner,
                        meta: "",
                        searchText: owner
                    });
                }
            });
            return rankMobileAutocompleteOptions([...ownerMap.values()], query);
        }

        function getLocationSuggestions(query) {
            const locationMap = new Map();
            const addLocation = (code, note = "") => {
                const normalized = norm(code);
                if (!normalized || locationMap.has(normalized)) return;
                locationMap.set(normalized, {
                    value: normalized,
                    title: normalized,
                    meta: note,
                    searchText: [normalized, note].filter(Boolean).join(" | ")
                });
            };

            state.masters.locations.forEach((location) => addLocation(location.code, location.note || ""));
            state.inventory.forEach((line) => addLocation(line.location));
            state.batch.forEach((line) => addLocation(line.location));
            return rankMobileAutocompleteOptions([...locationMap.values()], query);
        }

        function getLocationOwnerSet(location) {
            const normalizedLocation = norm(location);
            const owners = new Set();
            if (!normalizedLocation) return owners;
            state.inventory.forEach((line) => {
                if (norm(line.location) === normalizedLocation && norm(line.accountName)) {
                    owners.add(norm(line.accountName));
                }
            });
            return owners;
        }

        function isLocationCompatibleForOwner(accountName = "", location = "") {
            const owner = norm(accountName);
            const normalizedLocation = norm(location);
            if (!owner || !normalizedLocation) return false;
            const owners = getLocationOwnerSet(normalizedLocation);
            return owners.size === 0 || (owners.size === 1 && owners.has(owner));
        }

        function getOwnerScopedLocationOptions(accountName = "", { mode = "source", excludeLocation = "" } = {}) {
            const owner = norm(accountName);
            const exclude = norm(excludeLocation);
            if (!owner) return [];

            const locationMap = new Map();
            const addLocation = (code, note = "") => {
                const normalized = norm(code);
                if (!normalized || normalized === exclude || locationMap.has(normalized)) return;
                locationMap.set(normalized, {
                    value: normalized,
                    title: normalized,
                    meta: note,
                    searchText: [normalized, note].filter(Boolean).join(" | ")
                });
            };

            if (mode === "source") {
                state.inventory.forEach((line) => {
                    if (norm(line.accountName) !== owner) return;
                    addLocation(line.location, `${line.accountName} inventory`);
                });
                return [...locationMap.values()].sort((a, b) => a.value.localeCompare(b.value));
            }

            const noteByLocation = new Map();
            state.masters.locations.forEach((location) => {
                noteByLocation.set(norm(location.code), location.note || "");
            });

            const allLocations = new Set();
            state.masters.locations.forEach((location) => allLocations.add(norm(location.code)));
            state.inventory.forEach((line) => allLocations.add(norm(line.location)));

            [...allLocations].forEach((location) => {
                if (!location || location === exclude) return;
                if (!isLocationCompatibleForOwner(owner, location)) return;
                const owners = getLocationOwnerSet(location);
                const note = owners.size
                    ? `${owner} location`
                    : (noteByLocation.get(location) || "Open location");
                addLocation(location, note);
            });

            return [...locationMap.values()].sort((a, b) => a.value.localeCompare(b.value));
        }

        function getOwnerScopedLocationSuggestions(query, accountName = "", options = {}) {
            return rankMobileAutocompleteOptions(getOwnerScopedLocationOptions(accountName, options), query);
        }

        function getLocationInventoryItems(accountName = "", location = "") {
            const owner = norm(accountName);
            const sourceLocation = norm(location);
            if (!owner || !sourceLocation) return [];

            const itemMap = new Map();
            state.inventory.forEach((line) => {
                if (norm(line.accountName) !== owner || norm(line.location) !== sourceLocation) return;
                const sku = norm(line.sku);
                if (!sku) return;

                const key = sku;
                const trackingLevel = norm(line.trackingLevel || line.tracking || "UNIT");
                const existing = itemMap.get(key) || {
                    accountName: owner,
                    location: sourceLocation,
                    sku,
                    upc: norm(line.upc || ""),
                    description: String(line.description || "").trim().replace(/\s+/g, " "),
                    trackingLevel,
                    quantity: 0
                };

                if (!existing.upc && line.upc) existing.upc = norm(line.upc);
                if (!existing.description && line.description) existing.description = String(line.description).trim().replace(/\s+/g, " ");
                if (!existing.trackingLevel && trackingLevel) existing.trackingLevel = trackingLevel;
                if (existing.trackingLevel === trackingLevel) {
                    existing.quantity += toPositiveNumber(line.quantity) || 0;
                }
                itemMap.set(key, existing);
            });

            return [...itemMap.values()]
                .sort((a, b) => a.sku.localeCompare(b.sku) || a.upc.localeCompare(b.upc));
        }

        function getConvertibleSourceItems(accountName = "", location = "") {
            return getLocationInventoryItems(accountName, location)
                .map((item) => {
                    const master = findMasterItemByCode(item.sku, accountName);
                    return {
                        ...item,
                        unitsPerCase: master?.unitsPerCase ?? null,
                        trackingLevel: normalizeTrackingLevel(master?.trackingLevel || item.trackingLevel)
                    };
                })
                .filter((item) => item.trackingLevel !== "PALLET");
        }

        function getConvertibleTargetItems(accountName = "", excludeCode = "") {
            const owner = norm(accountName);
            const exclude = norm(excludeCode);
            if (!owner) return [];

            const itemMap = new Map();
            state.masters.items.forEach((item) => {
                if (item.accountName !== owner) return;
                const trackingLevel = normalizeTrackingLevel(item.trackingLevel);
                if (trackingLevel === "PALLET") return;
                const sku = norm(item.sku);
                if (!sku || sku === exclude) return;
                itemMap.set(sku, {
                    accountName: owner,
                    sku,
                    upc: norm(item.upc || ""),
                    description: String(item.description || "").trim().replace(/\s+/g, " "),
                    trackingLevel,
                    unitsPerCase: item.unitsPerCase ?? null
                });
            });
            return [...itemMap.values()].sort((a, b) => a.sku.localeCompare(b.sku) || a.upc.localeCompare(b.upc));
        }

        function getLocationScopedItemSuggestions(query, accountName = "", location = "", { preferUpc = false } = {}) {
            const items = getLocationInventoryItems(accountName, location);
            const normalizedQuery = norm(query);

            return rankMobileAutocompleteOptions(items.map((item) => {
                const useUpc = !!item.upc && (preferUpc || (normalizedQuery && item.upc.includes(normalizedQuery) && !item.sku.includes(normalizedQuery)));
                const primaryValue = useUpc ? item.upc : item.sku;
                const title = useUpc && item.sku ? `${item.upc} (${item.sku})` : primaryValue;
                const meta = [
                    item.location,
                    formatTrackedQuantity(item.quantity, item.trackingLevel || "UNIT"),
                    useUpc && item.sku ? `SKU ${item.sku}` : item.upc ? `UPC ${item.upc}` : "",
                    item.description
                ].filter(Boolean).join(" | ");
                return {
                    value: primaryValue,
                    title,
                    meta,
                    searchText: [item.accountName, item.location, item.sku, item.upc, item.description].filter(Boolean).join(" | "),
                    accountName: item.accountName,
                    item
                };
            }), normalizedQuery);
        }

        function getConvertibleTargetSuggestions(query, accountName = "", sourceCode = "", { preferUpc = false } = {}) {
            const items = getConvertibleTargetItems(accountName, sourceCode);
            const normalizedQuery = norm(query);

            return rankMobileAutocompleteOptions(items.map((item) => {
                const useUpc = !!item.upc && (preferUpc || (normalizedQuery && item.upc.includes(normalizedQuery) && !item.sku.includes(normalizedQuery)));
                const primaryValue = useUpc ? item.upc : item.sku;
                const title = useUpc && item.sku ? `${item.upc} (${item.sku})` : primaryValue;
                const meta = [
                    trackingLabel(item.trackingLevel),
                    item.unitsPerCase ? `${num(item.unitsPerCase)} ea/case` : "",
                    useUpc && item.sku ? `SKU ${item.sku}` : item.upc ? `UPC ${item.upc}` : "",
                    item.description
                ].filter(Boolean).join(" | ");
                return {
                    value: primaryValue,
                    title,
                    meta,
                    searchText: [item.accountName, item.sku, item.upc, item.description, item.trackingLevel].filter(Boolean).join(" | "),
                    accountName: item.accountName,
                    item
                };
            }), normalizedQuery);
        }

        function getItemSuggestions(query, accountName = "", { preferUpc = false } = {}) {
            const owner = norm(accountName);
            const items = getMobileItemSuggestionPool().filter((item) => !owner || item.accountName === owner);
            const normalizedQuery = norm(query);

            return rankMobileAutocompleteOptions(items.map((item) => {
                const useUpc = !!item.upc && (preferUpc || (normalizedQuery && item.upc.includes(normalizedQuery) && !item.sku.includes(normalizedQuery)));
                const primaryValue = useUpc ? item.upc : item.sku;
                const title = useUpc && item.sku ? `${item.upc} (${item.sku})` : primaryValue;
                const meta = [
                    item.accountName,
                    useUpc && item.sku ? `SKU ${item.sku}` : item.upc ? `UPC ${item.upc}` : "",
                    item.description
                ].filter(Boolean).join(" | ");
                return {
                    value: primaryValue,
                    title,
                    meta,
                    searchText: [item.accountName, item.sku, item.upc, item.description].filter(Boolean).join(" | "),
                    accountName: item.accountName,
                    itemId: item.itemId,
                    item
                };
            }), normalizedQuery);
        }

        function getMobileItemSuggestionPool() {
            const itemMap = new Map();
            const addItem = (item, isMaster = false) => {
                const accountName = norm(item?.accountName || item?.owner || item?.vendor || item?.customer || "");
                const sku = norm(item?.sku);
                if (!accountName || !sku) return;
                const key = `${accountName}::${sku}`;
                const existing = itemMap.get(key) || {
                    accountName,
                    sku,
                    upc: "",
                    description: "",
                    itemId: "",
                    item: null
                };
                itemMap.set(key, {
                    accountName,
                    sku,
                    upc: existing.upc || norm(item?.upc || ""),
                    description: existing.description || String(item?.description || "").trim().replace(/\s+/g, " "),
                    itemId: existing.itemId || (isMaster && typeof item?.id === "string" ? item.id : ""),
                    item: existing.item || (isMaster ? item : null)
                });
            };

            state.masters.items.forEach((item) => addItem(item, true));
            state.inventory.forEach((line) => addItem(line, false));
            state.batch.forEach((line) => addItem(line, false));
            return [...itemMap.values()];
        }

        function rankMobileAutocompleteOptions(options, query) {
            const normalizedQuery = norm(query);
            return options
                .map((option) => ({ option, score: scoreMobileAutocompleteOption(option, normalizedQuery) }))
                .filter((entry) => entry.score > 0)
                .sort((a, b) => b.score - a.score || a.option.value.localeCompare(b.option.value) || (a.option.meta || "").localeCompare(b.option.meta || ""))
                .map((entry) => entry.option);
        }

        function scoreMobileAutocompleteOption(option, query) {
            const value = norm(option.value);
            const title = norm(option.title || option.value);
            const meta = norm(option.meta || "");
            const searchText = norm(option.searchText || `${option.value} ${option.meta || ""}`);

            if (!query) {
                return value ? 1 : 0;
            }

            let score = 0;
            if (value === query) score += 1200;
            if (title === query) score += 1100;
            if (value.startsWith(query)) score += 700;
            if (title.startsWith(query)) score += 650;
            if (searchText.startsWith(query)) score += 500;
            if (value.includes(query)) score += 320;
            if (title.includes(query)) score += 280;
            if (meta.startsWith(query)) score += 180;
            if (meta.includes(query)) score += 120;
            if (searchText.includes(query)) score += 80;
            return score;
        }

        function looksNumeric(value) {
            return /^\d+$/.test(String(value || "").trim());
        }

        function scanEnterFlow(event) {
            if (event.key !== "Enter") return;
            if (event.target === ui.scanAccount) {
                event.preventDefault();
                ui.scanLocation.focus();
            } else if (event.target === ui.scanLocation) {
                event.preventDefault();
                ui.scanUpc.focus();
            } else if (event.target === ui.scanUpc) {
                event.preventDefault();
                ui.scanSku.focus();
            } else if (event.target === ui.scanSku) {
                event.preventDefault();
                ui.scanQuantity.focus();
            }
        }

        function focusScanStart() {
            if (!getActiveCompany() && !(ui.scanAccount.value || "").trim()) {
                ui.activeCompany?.focus();
                return;
            }
            if (!(ui.scanAccount.value || "").trim()) {
                ui.scanAccount.focus();
                return;
            }
            if (!(ui.scanLocation.value || "").trim()) {
                ui.scanLocation.focus();
                return;
            }
            ui.scanSku.focus();
        }

        function updateScanTrackingUi(item = null) {
            const trackingLevel = normalizeTrackingLevel(ui.scanTrackingLevel.value);
            const directQuantity = trackingLevel !== "UNIT";
            const itemDescription = String(item?.description || ui.scanDescription.value || "").trim();
            const casePack = item?.unitsPerCase ? `${num(item.unitsPerCase)} ea/case` : "";
            const eachDims = formatDimensions(item?.eachLength, item?.eachWidth, item?.eachHeight, "Each");
            const caseDims = formatDimensions(item?.caseLength, item?.caseWidth, item?.caseHeight, "Case");

            ui.scanHelperTitle.textContent = trackingLevel === "PALLET"
                ? "Pallet Qty Entry"
                : (trackingLevel === "CASE" ? "Case Qty Entry" : "Quick Qty Helper");
            ui.scanHelperMeta.textContent = directQuantity
                ? [
                    itemDescription,
                    trackingLevel === "CASE" ? "Enter case quantity directly." : "Enter pallet quantity directly.",
                    casePack,
                    eachDims,
                    caseDims
                ].filter(Boolean).join(" | ") || `Use quantity for ${trackingLabel(trackingLevel).toLowerCase()}. Case math is disabled for this tracking type.`
                : [itemDescription, casePack, eachDims, caseDims].filter(Boolean).join(" | ") || "Use case pack math for unit-tracked inventory.";

            ui.scanUom.disabled = directQuantity;
            ui.scanCases.disabled = directQuantity;
            ui.scanUom.placeholder = directQuantity ? "Not used" : "Optional";
            ui.scanCases.placeholder = directQuantity ? "Not used" : "Optional";

            if (directQuantity) {
                ui.scanUom.value = "";
                ui.scanCases.value = "";
            } else if (!ui.scanUom.value && item?.unitsPerCase) {
                ui.scanUom.value = String(item.unitsPerCase);
            }
        }

        function useLastLocation() {
            if (!state.preferences.lastLocation) {
                showMessage(ui.scanMessage, "No previous location has been saved yet.", "info");
                return;
            }
            ui.scanLocation.value = state.preferences.lastLocation;
            ui.scanSku.focus();
        }

        function addToBatch(event) {
            event.preventDefault();
            const matchedItem = syncScanFieldsFromCatalog();
            const accountName = getScopedCompanyValue(ui.scanAccount.value || state.preferences.lastAccount);
            const location = norm(ui.scanLocation.value || state.preferences.lastLocation);
            const upc = norm(ui.scanUpc.value);
            const sku = norm(ui.scanSku.value);
            const description = String(ui.scanDescription.value || matchedItem?.description || "").trim().replace(/\s+/g, " ");
            const imageUrl = normalizeImageReference(ui.scanImageUrl.value || matchedItem?.imageUrl || "");
            const trackingLevel = normalizeTrackingLevel(ui.scanTrackingLevel.value || matchedItem?.trackingLevel);
            let quantity = toPositiveInt(ui.scanQuantity.value);

            if (!accountName) return fail(ui.scanMessage, "Please choose a company.", ui.scanAccount);
            if (!location) return fail(ui.scanMessage, "Please scan or enter a location.", ui.scanLocation);
            if (!sku) return fail(ui.scanMessage, "Please scan or enter a SKU.", ui.scanSku);
            if (!quantity) quantity = calculateQuantity(false);
            if (!quantity) return fail(ui.scanMessage, "Enter a quantity. Unit-tracked items can also use Units per Case and Cases to calculate one.", ui.scanQuantity);

            setActiveCompany(accountName, { force: true, rerender: false });
            state.preferences.lastAccount = accountName;
            state.preferences.lastLocation = location;
            state.batch.push({
                id: makeId("batch"),
                accountName,
                location,
                sku,
                upc,
                description,
                imageUrl,
                trackingLevel,
                quantity,
                addedAt: new Date().toISOString()
            });
            saveState();
            renderBatch();
            renderStats();
            renderDatalists();
            renderSummary();
            showMessage(ui.scanMessage, `Added ${accountName} / ${sku} (${formatTrackedQuantity(quantity, trackingLevel)}) to the batch for ${location}.`, "success");

            ui.scanAccount.value = accountName;
            ui.scanLocation.value = location;
            ui.scanUpc.value = "";
            ui.scanSku.value = "";
            ui.scanDescription.value = "";
            ui.scanQuantity.value = "";
            ui.scanUom.value = "";
            ui.scanCases.value = "";
            clearImageField({
                urlInput: ui.scanImageUrl,
                previewWrap: ui.scanImagePreviewWrap,
                previewImg: ui.scanImagePreview,
                previewMeta: ui.scanImagePreviewMeta,
                clearBtn: ui.scanImageClearBtn,
                defaultMeta: "Compressed photo preview"
            });
            updateScanTrackingUi();
            ui.scanSku.focus();
        }

        function calculateQuantity(announce) {
            const trackingLevel = normalizeTrackingLevel(ui.scanTrackingLevel.value);
            if (trackingLevel !== "UNIT") {
                if (announce) showMessage(ui.scanMessage, `${trackingLabel(trackingLevel)} use the Quantity field directly.`, "info");
                return toPositiveInt(ui.scanQuantity.value);
            }
            const uom = toPositiveInt(ui.scanUom.value);
            const cases = toPositiveInt(ui.scanCases.value);
            if (!uom || !cases) {
                if (announce) showMessage(ui.scanMessage, "Enter both Units per Case and Cases to calculate quantity.", "info");
                return null;
            }
            const quantity = uom * cases;
            ui.scanQuantity.value = String(quantity);
            if (announce) showMessage(ui.scanMessage, `Calculated quantity: ${num(quantity)} units.`, "info");
            ui.scanQuantity.focus();
            return quantity;
        }

        async function saveBatchToInventory() {
            if (!state.batch.length) return showMessage(ui.scanMessage, "There are no staged items to save.", "error");

            const grouped = new Map();
            state.batch.forEach((line) => {
                const key = `${line.accountName}::${line.location}::${line.sku}`;
                const current = grouped.get(key) || {
                    accountName: line.accountName,
                    location: line.location,
                    sku: line.sku,
                    upc: line.upc,
                    description: line.description || "",
                    imageUrl: line.imageUrl || "",
                    trackingLevel: line.trackingLevel,
                    quantity: 0
                };
                current.quantity += line.quantity;
                if (!current.upc && line.upc) current.upc = line.upc;
                if (!current.description && line.description) current.description = line.description;
                if (!current.imageUrl && line.imageUrl) current.imageUrl = line.imageUrl;
                current.trackingLevel = line.trackingLevel || current.trackingLevel || "UNIT";
                grouped.set(key, current);
            });

            try {
                await requestJson("/api/batch-save", {
                    method: "POST",
                    body: JSON.stringify({ items: [...grouped.values()] })
                });

                state.batch = [];
                saveState();
                await syncServerState(true);
                showMessage(ui.scanMessage, "Batch saved to the shared server inventory.", "success");
                focusScanStart();
            } catch (error) {
                showMessage(ui.scanMessage, error.message, "error");
            }
        }

        function clearBatch() {
            if (!state.batch.length) return showMessage(ui.scanMessage, "The batch is already empty.", "info");
            if (!window.confirm("Clear all staged scan lines from the current batch?")) return;
            state.batch = [];
            saveState();
            renderBatch();
            renderStats();
            renderDatalists();
            renderSummary();
            showMessage(ui.scanMessage, "Batch cleared.", "info");
        }

        function onBatchTableClick(event) {
            const button = event.target.closest("[data-batch-remove]");
            if (!button) return;
            state.batch = state.batch.filter((line) => line.id !== button.dataset.batchRemove);
            saveState();
            renderBatch();
            renderStats();
            renderDatalists();
            renderSummary();
            showMessage(ui.scanMessage, "Removed line from batch.", "info");
        }

        async function performSingleSearch(rawValue, announce = true) {
            const query = norm(rawValue);
            const ownerFilter = getScopedCompanyValue(ui.searchAccount.value);
            if (!query) return showMessage(ui.searchMessage, "Enter a SKU, UPC, or location to search.", "error");
            try {
                await syncServerState(true);

                const matches = getScopedInventory(ownerFilter).filter((line) => searchMode === "sku"
                    ? line.sku.includes(query) || (line.upc || "").includes(query)
                    : line.location.includes(query)
                );

                lastSingleSearch = { mode: searchMode, query, ownerFilter, matches };
                lastMultiSearch = null;
                currentSearchView = { kind: "single", mode: searchMode, query, ownerFilter };
                renderSingleSearch(query, searchMode, matches);
                if (announce) showMessage(ui.searchMessage, matches.length ? `Found ${num(matches.length)} matching line${matches.length === 1 ? "" : "s"}.` : `No matches found for ${query}.`, matches.length ? "success" : "info");
            } catch (error) {
                showMessage(ui.searchMessage, error.message, "error");
            }
        }

        async function performMultiSearch(rawValue, announce = true) {
            const terms = [...new Set(String(rawValue || "").split(/[\s,]+/).map(norm).filter(Boolean))];
            const ownerFilter = getScopedCompanyValue(ui.searchAccount.value);
            if (!terms.length) return showMessage(ui.searchMessage, "Enter at least one SKU or UPC for multi-search.", "error");
            try {
                await syncServerState(true);

                const groups = terms.map((term) => {
                    const matches = getScopedInventory(ownerFilter).filter((line) => line.sku.includes(term) || (line.upc || "").includes(term));
                    return { term, matches, totals: summarizeTrackedTotals(matches) };
                });

                lastMultiSearch = { terms, ownerFilter, groups };
                lastSingleSearch = null;
                currentSearchView = { kind: "multi", terms, ownerFilter };
                renderMultiSearch(groups);
                if (announce) {
                    const found = groups.filter((group) => group.matches.length).length;
                    showMessage(ui.searchMessage, `Found results for ${num(found)} of ${num(groups.length)} requested item${groups.length === 1 ? "" : "s"}.`, found ? "success" : "info");
                }
            } catch (error) {
                showMessage(ui.searchMessage, error.message, "error");
            }
        }

        function renderAll() {
            renderBatch();
            renderStats();
            renderDatalists();
            renderMasterLibrary();
            renderBilling();
            renderLabelTool();
            renderActivity();
            renderInventory(ui.inventoryFilter.value);
            renderReports(ui.reportFilter.value);
            renderSummary();
            syncScanItemSelectors();
            syncPalletLabelSkuOptions();
        }

        function renderBatch() {
            const batch = [...state.batch].sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt));
            ui.lastLocationMeta.textContent = state.preferences.lastLocation ? `Last location: ${state.preferences.lastLocation}` : "No saved location yet";
            ui.batchMeta.textContent = `${num(batch.length)} line${batch.length === 1 ? "" : "s"} staged`;
            ui.saveBatchButtons.forEach((button) => { button.disabled = !batch.length; });
            ui.clearBatchButtons.forEach((button) => { button.disabled = !batch.length; });

            if (!batch.length) {
                ui.batchEmpty.classList.remove("hidden");
                ui.batchTableWrap.classList.add("hidden");
                ui.batchTableBody.innerHTML = "";
                return;
            }

            ui.batchEmpty.classList.add("hidden");
            ui.batchTableWrap.classList.remove("hidden");
            ui.batchTableBody.innerHTML = batch.map((line) => `
                <tr>
                    <td>${esc(line.accountName || "-")}</td>
                    <td>${esc(line.location)}</td>
                    <td>${esc(line.sku)}</td>
                    <td>${esc(line.upc || "-")}</td>
                    <td>${esc(line.description || "-")}</td>
                    <td>${esc(trackingLabel(line.trackingLevel))}</td>
                    <td>${num(line.quantity)}</td>
                    <td>${esc(formatDate(line.addedAt))}</td>
                    <td><button class="btn ghost mini" type="button" data-batch-remove="${line.id}">Remove</button></td>
                </tr>
            `).join("");
        }

        function renderStats() {
            const scopedInventory = getScopedInventory();
            const trackedTotals = summarizeTrackedTotals(scopedInventory);
            const locations = new Set(scopedInventory.map((line) => line.location)).size;
            ui.statUnits.textContent = formatTrackedSummary(trackedTotals);
            ui.statLines.textContent = num(scopedInventory.length);
            ui.statLocations.textContent = num(locations);
            ui.statBatch.textContent = num(state.batch.length);
        }

        function renderDatalists() {
            const locationMap = new Map();
            state.masters.locations.forEach((entry) => {
                locationMap.set(entry.code, { value: entry.code, label: entry.note || "" });
            });
            state.inventory.forEach((line) => {
                if (!locationMap.has(line.location)) {
                    locationMap.set(line.location, { value: line.location, label: "" });
                }
            });
            state.batch.forEach((line) => {
                if (!locationMap.has(line.location)) {
                    locationMap.set(line.location, { value: line.location, label: "" });
                }
            });

            const ownerMap = new Map();
            (state.masters.ownerRecords || []).forEach((owner) => {
                ownerMap.set(owner.name, { value: owner.name, label: owner.note || "" });
            });
            getOwnerOptions().forEach((owner) => {
                if (!ownerMap.has(owner)) ownerMap.set(owner, { value: owner, label: "" });
            });

            const itemMap = new Map();
            state.masters.items.forEach((item) => {
                const skuLabel = [item.accountName, item.upc ? `UPC ${item.upc}` : "", item.description].filter(Boolean).join(" | ");
                itemMap.set(`SKU::${item.accountName}::${item.sku}`, { value: item.sku, label: skuLabel });
                if (item.upc) {
                    itemMap.set(`UPC::${item.accountName}::${item.upc}`, { value: item.upc, label: [item.accountName, item.sku, item.description].filter(Boolean).join(" | ") });
                }
            });
            state.inventory.forEach((line) => {
                if (!ownerMap.has(line.accountName)) ownerMap.set(line.accountName, { value: line.accountName, label: "" });
                const skuKey = `SKU::${line.accountName}::${line.sku}`;
                const upcKey = `UPC::${line.accountName}::${line.upc}`;
                if (!itemMap.has(skuKey)) itemMap.set(skuKey, { value: line.sku, label: [line.accountName, line.upc ? `UPC ${line.upc}` : ""].filter(Boolean).join(" | ") });
                if (line.upc && !itemMap.has(upcKey)) itemMap.set(upcKey, { value: line.upc, label: `${line.accountName} | ${line.sku}` });
            });
            state.batch.forEach((line) => {
                if (!ownerMap.has(line.accountName)) ownerMap.set(line.accountName, { value: line.accountName, label: "" });
                const skuKey = `SKU::${line.accountName}::${line.sku}`;
                const upcKey = `UPC::${line.accountName}::${line.upc}`;
                if (!itemMap.has(skuKey)) itemMap.set(skuKey, { value: line.sku, label: [line.accountName, line.upc ? `UPC ${line.upc}` : ""].filter(Boolean).join(" | ") });
                if (line.upc && !itemMap.has(upcKey)) itemMap.set(upcKey, { value: line.upc, label: `${line.accountName} | ${line.sku}` });
            });

            ui.locationList.innerHTML = [...locationMap.values()]
                .sort((a, b) => a.value.localeCompare(b.value))
                .map((entry) => `<option value="${attr(entry.value)}">${esc(entry.label)}</option>`)
                .join("");
            const ownerOptions = [...ownerMap.values()].sort((a, b) => a.value.localeCompare(b.value));
            ui.ownerList.innerHTML = ownerOptions
                .map((entry) => `<option value="${attr(entry.value)}">${esc(entry.label || entry.value)}</option>`)
                .join("");
            renderActiveCompanyOptions(ownerOptions.map((entry) => entry.value));
            ui.skuList.innerHTML = [...itemMap.values()]
                .sort((a, b) => a.value.localeCompare(b.value) || a.label.localeCompare(b.label))
                .map((entry) => `<option value="${attr(entry.value)}">${esc(entry.label)}</option>`)
                .join("");
            renderActionSkuDatalists();
            refreshMobileAutocomplete();
        }

        function renderActiveCompanyOptions(owners = []) {
            if (!ui.activeCompany) return;
            const current = norm(ui.activeCompany.value || state.preferences.activeCompany || "");
            const uniqueOwners = [...new Set((owners || []).map((owner) => norm(owner)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
            const options = ['<option value="">Select company…</option>']
                .concat(uniqueOwners.map((owner) => `<option value="${attr(owner)}">${esc(owner)}</option>`));
            ui.activeCompany.innerHTML = options.join('');
            ui.activeCompany.value = current && uniqueOwners.includes(current) ? current : '';
        }

        function renderActionSkuDatalists() {
            const renderLocationOptions = (entries) => entries
                .map((entry) => `<option value="${attr(entry.value)}">${esc(entry.meta || "")}</option>`)
                .join("");
            const renderOptions = (items) => items
                .map((item) => {
                    const label = [
                        formatTrackedQuantity(item.quantity, item.trackingLevel || "UNIT"),
                        item.upc ? `UPC ${item.upc}` : "",
                        item.description
                    ].filter(Boolean).join(" | ");
                    return `<option value="${attr(item.sku)}">${esc(label)}</option>`;
                })
                .join("");
            const renderConversionTargetOptions = (items) => items
                .map((item) => {
                    const label = [
                        trackingLabel(item.trackingLevel),
                        item.unitsPerCase ? `${num(item.unitsPerCase)} ea/case` : "",
                        item.upc ? `UPC ${item.upc}` : "",
                        item.description
                    ].filter(Boolean).join(" | ");
                    return `<option value="${attr(item.sku)}">${esc(label)}</option>`;
                })
                .join("");

            const adjustAccountName = getScopedCompanyValue(ui.adjustAccount?.value || "");
            const transferAccountName = getScopedCompanyValue(ui.transferAccount?.value || "");
            const convertAccountName = getScopedCompanyValue(ui.convertAccount?.value || "");
            const moveAccountName = getScopedCompanyValue(ui.moveAccount?.value || "");
            const adjustLocations = getOwnerScopedLocationOptions(adjustAccountName, { mode: "source" });
            const transferFromLocations = getOwnerScopedLocationOptions(transferAccountName, { mode: "source" });
            const transferToLocations = getOwnerScopedLocationOptions(transferAccountName, {
                mode: "destination",
                excludeLocation: ui.transferFrom?.value || ""
            });
            const convertFromLocations = getOwnerScopedLocationOptions(convertAccountName, { mode: "source" });
            const convertToLocations = getOwnerScopedLocationOptions(convertAccountName, { mode: "destination" });
            const moveFromLocations = getOwnerScopedLocationOptions(moveAccountName, { mode: "source" });
            const moveToLocations = getOwnerScopedLocationOptions(moveAccountName, {
                mode: "destination",
                excludeLocation: ui.moveFrom?.value || ""
            });

            const adjustItems = getLocationInventoryItems(adjustAccountName, ui.adjustLocation?.value || "");
            const transferItems = getLocationInventoryItems(transferAccountName, ui.transferFrom?.value || "");
            if (ui.convertTo && !norm(ui.convertTo.value) && norm(ui.convertFrom?.value || "")) {
                ui.convertTo.value = norm(ui.convertFrom.value);
            }
            const convertSourceItems = getConvertibleSourceItems(convertAccountName, ui.convertFrom?.value || "");
            const convertTargetItems = getConvertibleTargetItems(convertAccountName, ui.convertSourceSku?.value || "");

            if (ui.adjustLocationList) ui.adjustLocationList.innerHTML = renderLocationOptions(adjustLocations);
            if (ui.transferFromList) ui.transferFromList.innerHTML = renderLocationOptions(transferFromLocations);
            if (ui.transferToList) ui.transferToList.innerHTML = renderLocationOptions(transferToLocations);
            if (ui.convertFromList) ui.convertFromList.innerHTML = renderLocationOptions(convertFromLocations);
            if (ui.convertToList) ui.convertToList.innerHTML = renderLocationOptions(convertToLocations);
            if (ui.moveFromList) ui.moveFromList.innerHTML = renderLocationOptions(moveFromLocations);
            if (ui.moveToList) ui.moveToList.innerHTML = renderLocationOptions(moveToLocations);
            if (ui.adjustSkuList) ui.adjustSkuList.innerHTML = renderOptions(adjustItems);
            if (ui.transferSkuList) ui.transferSkuList.innerHTML = renderOptions(transferItems);
            if (ui.convertSourceSkuList) ui.convertSourceSkuList.innerHTML = renderOptions(convertSourceItems);
            if (ui.convertTargetSkuList) ui.convertTargetSkuList.innerHTML = renderConversionTargetOptions(convertTargetItems);

            const syncLocationField = (input, locations, waitingText, readyText) => {
                if (!input) return;
                const currentValue = norm(input.value);
                const scopeReady = input === ui.adjustLocation
                    ? !!adjustAccountName
                    : input === ui.transferFrom
                        ? !!transferAccountName
                        : input === ui.transferTo
                            ? !!transferAccountName && !!norm(ui.transferFrom?.value)
                            : input === ui.convertFrom
                                ? !!convertAccountName
                                : input === ui.convertTo
                                    ? !!convertAccountName
                            : input === ui.moveFrom
                                ? !!moveAccountName
                                : !!moveAccountName && !!norm(ui.moveFrom?.value);

                input.disabled = !scopeReady;
                input.placeholder = scopeReady
                    ? (locations.length ? readyText : "No valid locations available")
                    : waitingText;

                if (currentValue && !locations.some((entry) => entry.value === currentValue)) {
                    input.value = "";
                }
            };

            const syncField = (input, items, waitingText, readyText) => {
                if (!input) return;
                const isReady = items.length > 0;
                const scopeReady = input === ui.transferSku
                    ? !!transferAccountName && !!norm(ui.transferFrom?.value)
                    : input === ui.convertSourceSku
                        ? !!convertAccountName && !!norm(ui.convertFrom?.value)
                        : input === ui.convertTargetSku
                            ? !!convertAccountName
                    : !!adjustAccountName && !!norm(ui.adjustLocation?.value);

                input.disabled = !scopeReady;
                input.placeholder = scopeReady
                    ? (isReady ? readyText : "No matching SKUs in the selected location")
                    : waitingText;

                const currentValue = norm(input.value);
                if (currentValue && !items.some((item) => item.sku === currentValue || item.upc === currentValue)) {
                    input.value = "";
                }
            };

            syncLocationField(ui.adjustLocation, adjustLocations, "Choose company first", "Select a location for this company");
            syncLocationField(ui.transferFrom, transferFromLocations, "Choose company first", "Select the source location");
            syncLocationField(ui.transferTo, transferToLocations, "Choose company and source location first", "Select a valid destination location");
            syncLocationField(ui.convertFrom, convertFromLocations, "Choose company first", "Select the source location");
            syncLocationField(ui.convertTo, convertToLocations, "Choose company first", "Select the destination location");
            syncLocationField(ui.moveFrom, moveFromLocations, "Choose company first", "Select the source location");
            syncLocationField(ui.moveTo, moveToLocations, "Choose company and source location first", "Select a valid destination location");
            syncField(ui.adjustSku, adjustItems, "Choose company and location first", "Select a SKU from this location");
            syncField(ui.transferSku, transferItems, "Choose company and source location first", "Select a SKU from the source location");
            syncField(ui.convertSourceSku, convertSourceItems, "Choose company and source location first", "Select the source SKU from this location");
            syncField(ui.convertTargetSku, convertTargetItems, "Choose company first", "Select the target SKU for this company");
            updateConversionPreview();
        }

        function syncActionItemSelectors() {
            renderActionSkuDatalists();
            refreshMobileAutocomplete();
        }

        function clearScanCatalogFields() {
            ui.scanSku.value = "";
            ui.scanUpc.value = "";
            ui.scanDescription.value = "";
            ui.scanImageUrl.value = "";
            ui.scanTrackingLevel.value = "UNIT";
            refreshImagePreview({
                urlInput: ui.scanImageUrl,
                previewWrap: ui.scanImagePreviewWrap,
                previewImg: ui.scanImagePreview,
                previewMeta: ui.scanImagePreviewMeta,
                clearBtn: ui.scanImageClearBtn,
                defaultMeta: "Compressed photo preview"
            });
            updateScanTrackingUi();
        }

        function syncScanItemSelectors() {
            const owner = getScopedCompanyValue(ui.scanAccount.value);
            const ownerItems = owner ? getMobileItemSuggestionPool().filter((item) => item.accountName === owner) : [];
            const skuCode = norm(ui.scanSku.value);
            const upcCode = norm(ui.scanUpc.value);
            const hasValidCurrentItem = !owner
                || (!skuCode && !upcCode)
                || ownerItems.some((item) => item.sku === skuCode || (!!upcCode && item.upc === upcCode));

            ui.scanSku.disabled = !owner;
            ui.scanUpc.disabled = !owner;
            ui.scanSku.placeholder = owner
                ? (ownerItems.length ? "Select a SKU for this company" : "No saved SKUs for this company")
                : "Choose company first";
            ui.scanUpc.placeholder = owner
                ? (ownerItems.some((item) => !!item.upc) ? "Select a UPC for this company" : "No saved UPCs for this company")
                : "Choose company first";

            if (ui.scanSkuList) {
                ui.scanSkuList.innerHTML = ownerItems
                    .sort((a, b) => a.sku.localeCompare(b.sku) || (a.upc || "").localeCompare(b.upc || ""))
                    .map((item) => {
                        const label = [item.upc ? `UPC ${item.upc}` : "", item.description].filter(Boolean).join(" | ");
                        return `<option value="${attr(item.sku)}">${esc(label)}</option>`;
                    })
                    .join("");
            }

            if (ui.scanUpcList) {
                ui.scanUpcList.innerHTML = ownerItems
                    .filter((item) => !!item.upc)
                    .sort((a, b) => (a.upc || "").localeCompare(b.upc || "") || a.sku.localeCompare(b.sku))
                    .map((item) => {
                        const label = [item.sku, item.description].filter(Boolean).join(" | ");
                        return `<option value="${attr(item.upc)}">${esc(label)}</option>`;
                    })
                    .join("");
            }

            if (!hasValidCurrentItem) {
                clearScanCatalogFields();
            }
        }

        function findClientInventoryLine(accountName = "", location = "", skuOrUpc = "") {
            const owner = norm(accountName);
            const normalizedLocation = norm(location);
            const itemCode = norm(skuOrUpc);
            if (!owner || !normalizedLocation || !itemCode) return null;

            const skuMatches = state.inventory.filter((line) =>
                norm(line.accountName) === owner &&
                norm(line.location) === normalizedLocation &&
                norm(line.sku) === itemCode
            );
            if (skuMatches.length === 1) return skuMatches[0];

            const upcMatches = state.inventory.filter((line) =>
                norm(line.accountName) === owner &&
                norm(line.location) === normalizedLocation &&
                norm(line.upc) === itemCode
            );
            if (upcMatches.length > 1) return { duplicateUpc: true };
            return upcMatches[0] || null;
        }

        function getForeignOwnersAtLocation(accountName = "", location = "") {
            const owner = norm(accountName);
            const normalizedLocation = norm(location);
            if (!owner || !normalizedLocation) return [];
            return [...new Set(
                state.inventory
                    .filter((line) => norm(line.location) === normalizedLocation && norm(line.accountName) && norm(line.accountName) !== owner)
                    .map((line) => norm(line.accountName))
            )].sort((a, b) => a.localeCompare(b));
        }

        function setLabelToolMode(mode) {
            labelToolState.mode = mode === "pallet" ? "pallet" : "location";
            ui.labelModeButtons.forEach((button) => {
                const isActive = button.dataset.labelMode === labelToolState.mode;
                button.classList.toggle("active", isActive);
                button.classList.toggle("ghost", !isActive);
            });
            ui.locationLabelTool.classList.toggle("hidden", labelToolState.mode !== "location");
            ui.locationLabelLibraryTool.classList.toggle("hidden", labelToolState.mode !== "location");
            ui.palletLabelTool.classList.toggle("hidden", labelToolState.mode !== "pallet");
            saveLabelToolState();
            renderLabelTool();
        }

        function renderLabelTool() {
            if (!ui.labelsPreviewGrid) return;
            const locationCandidates = getLocationLabelCandidates(ui.labelLibraryFilterInput?.value || "");
            ui.labelLibraryMeta.textContent = `${num(locationCandidates.length)} matching saved BIN label${locationCandidates.length === 1 ? "" : "s"} available.`;

            if (labelToolState.mode === "pallet") {
                ui.labelPreviewTitle.textContent = "Pallet Label Preview";
                ui.labelPreviewLead.textContent = "Saved pallet records live on the server. This print queue stays on this device so you can reprint the pallets you just worked on.";
                ui.labelPreviewMeta.textContent = `${num(labelToolState.palletLabels.length)} pallet label${labelToolState.palletLabels.length === 1 ? "" : "s"} queued`;
                ui.printLabelsBtn.disabled = !labelToolState.palletLabels.length;
                ui.exportLabelCodesBtn.disabled = !labelToolState.palletLabels.length;
                ui.exportLabelCodesBtn.textContent = "Export Pallet CSV";
                ui.labelsPreviewEmpty.textContent = "No pallet labels queued yet. Save or load a pallet to add it here for printing.";

                if (!labelToolState.palletLabels.length) {
                    ui.labelsPreviewEmpty.classList.remove("hidden");
                    ui.labelsPreviewGrid.innerHTML = "";
                    return;
                }

                ui.labelsPreviewEmpty.classList.add("hidden");
                ui.labelsPreviewGrid.innerHTML = labelToolState.palletLabels.map((entry) => buildPalletLabelMarkup(entry)).join("");
                return;
            }

            ui.labelPreviewTitle.textContent = "Location Label Preview";
            ui.labelPreviewLead.textContent = "Preview 4 x 6 landscape location labels before printing. Queue stays on this device so you can build labels without affecting the shared inventory.";
            ui.labelPreviewMeta.textContent = `${num(labelToolState.labels.length)} label${labelToolState.labels.length === 1 ? "" : "s"} queued`;
            ui.printLabelsBtn.disabled = !labelToolState.labels.length;
            ui.exportLabelCodesBtn.disabled = !labelToolState.labels.length;
            ui.exportLabelCodesBtn.textContent = "Export Codes CSV";
            ui.labelsPreviewEmpty.textContent = "No labels queued yet. Add one, paste a list, or pull matching BINs from the shared location library.";

            if (!labelToolState.labels.length) {
                ui.labelsPreviewEmpty.classList.remove("hidden");
                ui.labelsPreviewGrid.innerHTML = "";
                return;
            }

            ui.labelsPreviewEmpty.classList.add("hidden");
            ui.labelsPreviewGrid.innerHTML = labelToolState.labels.map((code) => {
                const details = getLocationLabelDetails(code);
                const compactClass = details.code.length > 11 ? " compact" : "";
                return `
                    <div class="location-label-card">
                        <div class="location-print-label">
                            <div class="location-barcode-line" aria-hidden="true"></div>
                            <div>
                                <p class="location-label-code${compactClass}">${esc(details.code)}</p>
                                <div class="location-label-meta${compactClass}">${esc(details.meta)}</div>
                            </div>
                        </div>
                    </div>
                `;
            }).join("");
        }

        function persistLocationLabelDraft() {
            labelToolState.rack = sanitizeLabelDigits(ui.labelRackInput.value, 3) || labelToolState.rack || "106";
            labelToolState.bin = sanitizeLabelDigits(ui.labelBinInput.value, 2) || labelToolState.bin || "01";
            labelToolState.level = sanitizeLabelLevel(ui.labelLevelInput.value);
            labelToolState.side = sanitizeLabelSide(ui.labelSideInput.value);
            labelToolState.bulk = String(ui.labelBulkInput.value || "");
            labelToolState.filter = String(ui.labelLibraryFilterInput.value || "").trim().toUpperCase();
            saveLabelToolState();
            renderLabelTool();
        }

        function persistPalletLabelDraft() {
            labelToolState.palletCode = norm(ui.palletLabelCode.value || "");
            labelToolState.palletAccount = norm(ui.palletLabelAccount.value || "");
            labelToolState.palletSku = norm(ui.palletLabelSku.value || "");
            labelToolState.palletDescription = String(ui.palletLabelDescription.value || "").trim().replace(/\s+/g, " ");
            labelToolState.palletCases = String(ui.palletLabelCases.value || "").trim();
            labelToolState.palletDate = normalizeLabelDate(ui.palletLabelDate.value) || todayInputValue();
            labelToolState.palletLocation = norm(ui.palletLabelLocation.value || "");
            saveLabelToolState();
            syncPalletLabelSkuOptions();
            renderLabelTool();
        }

        function addSingleLocationLabel() {
            persistLocationLabelDraft();
            addLocationLabelsFromCodes([
                buildRackBinLocationCode(ui.labelRackInput.value, ui.labelBinInput.value, ui.labelLevelInput.value, ui.labelSideInput.value)
            ], "Added one label.");
        }

        function addLocationLabelPair() {
            persistLocationLabelDraft();
            addLocationLabelsFromCodes([
                buildRackBinLocationCode(ui.labelRackInput.value, ui.labelBinInput.value, 1, ui.labelSideInput.value),
                buildRackBinLocationCode(ui.labelRackInput.value, ui.labelBinInput.value, 2, ui.labelSideInput.value)
            ], "Added paired level labels.");
        }

        function addBulkLocationLabels() {
            persistLocationLabelDraft();
            const codes = String(ui.labelBulkInput.value || "")
                .split(/\r?\n+/)
                .map((line) => line.trim())
                .filter(Boolean);
            addLocationLabelsFromCodes(codes, "Added bulk labels.");
        }

        function addSavedLocationLabels() {
            persistLocationLabelDraft();
            const codes = getLocationLabelCandidates(ui.labelLibraryFilterInput.value || "");
            addLocationLabelsFromCodes(codes, "Added matching saved BIN labels.");
        }

        function addLocationLabelsFromCodes(codes, successPrefix = "Updated labels.") {
            const existing = new Set(labelToolState.labels);
            const incoming = [];
            let invalidCount = 0;
            let duplicateCount = 0;

            codes.forEach((code) => {
                const normalized = normalizeLocationLabelCode(code);
                if (!normalized) {
                    invalidCount += 1;
                    return;
                }
                if (existing.has(normalized) || incoming.includes(normalized)) {
                    duplicateCount += 1;
                    return;
                }
                incoming.push(normalized);
            });

            if (!incoming.length) {
                const parts = [];
                if (duplicateCount) parts.push(`${num(duplicateCount)} duplicate${duplicateCount === 1 ? "" : "s"} skipped`);
                if (invalidCount) parts.push(`${num(invalidCount)} invalid code${invalidCount === 1 ? "" : "s"} skipped`);
                showMessage(ui.labelsMessage, parts.length ? `No new labels added. ${parts.join(" | ")}.` : "No valid labels were added.", "error");
                return;
            }

            labelToolState.labels = [...labelToolState.labels, ...incoming];
            saveLabelToolState();
            renderLabelTool();

            const detailParts = [`${num(incoming.length)} label${incoming.length === 1 ? "" : "s"} added`];
            if (duplicateCount) detailParts.push(`${num(duplicateCount)} duplicate${duplicateCount === 1 ? "" : "s"} skipped`);
            if (invalidCount) detailParts.push(`${num(invalidCount)} invalid code${invalidCount === 1 ? "" : "s"} skipped`);
            showMessage(ui.labelsMessage, `${successPrefix} ${detailParts.join(" | ")}.`, "success");
        }

        function clearLocationLabels() {
            labelToolState.labels = [];
            saveLabelToolState();
            renderLabelTool();
            showMessage(ui.labelsMessage, "Cleared the queued location labels for this device.", "info");
        }

        function syncPalletLabelSkuOptions() {
            const accountName = getScopedCompanyValue(ui.palletLabelAccount.value || "");
            const items = getPalletLabelItems(accountName);
            ui.palletLabelSku.disabled = !accountName;
            ui.palletLabelSku.placeholder = accountName
                ? (items.length ? "Choose a SKU for this company" : "No saved SKUs for this company")
                : "Choose company first";
            if (ui.palletLabelSkuList) {
                ui.palletLabelSkuList.innerHTML = items.map((item) => {
                    const label = [item.description, item.upc ? `UPC ${item.upc}` : "", formatTrackedQuantity(item.quantity, item.trackingLevel)].filter(Boolean).join(" | ");
                    return `<option value="${attr(item.sku)}">${esc(label)}</option>`;
                }).join("");
            }
            const currentSku = norm(ui.palletLabelSku.value || "");
            if (currentSku && !items.some((item) => item.sku === currentSku)) {
                ui.palletLabelSku.value = "";
                ui.palletLabelDescription.value = "";
            }
        }

        function syncPalletLabelCatalogFields() {
            syncPalletLabelSkuOptions();
            const accountName = getScopedCompanyValue(ui.palletLabelAccount.value || "");
            const sku = norm(ui.palletLabelSku.value || "");
            if (accountName) {
                setActiveCompany(accountName, { force: true, rerender: false });
            }
            if (!accountName || !sku) {
                persistPalletLabelDraft();
                return;
            }
            const master = state.masters.items.find((item) => item.accountName === accountName && item.sku === sku)
                || state.inventory.find((line) => line.accountName === accountName && line.sku === sku)
                || null;
            if (master && (!ui.palletLabelDescription.value.trim() || ui.palletLabelDescription.dataset.autofilled === "true")) {
                const description = typeof master.description === "string" ? master.description : (getLineDescription(master) || "");
                ui.palletLabelDescription.value = description || "";
                ui.palletLabelDescription.dataset.autofilled = "true";
            }
            if (!master && !ui.palletLabelDescription.value.trim()) {
                ui.palletLabelDescription.dataset.autofilled = "true";
            }
            persistPalletLabelDraft();
        }

        async function loadPalletLabelRecord() {
            const palletCode = norm(ui.palletLabelCode.value || "");
            if (!palletCode) {
                return fail(ui.labelsMessage, "Scan or enter a pallet ID first.", ui.palletLabelCode);
            }

            try {
                const payload = await requestJson(`/api/pallets/${encodeURIComponent(palletCode)}`);
                const pallet = sanitizePalletLabelEntry(payload?.pallet);
                if (!pallet) {
                    throw new Error("That pallet could not be loaded.");
                }
                const existingIndex = state.pallets.findIndex((item) => item.palletCode === pallet.palletCode);
                if (existingIndex >= 0) state.pallets.splice(existingIndex, 1, pallet);
                else state.pallets.unshift(pallet);
                populatePalletLabelForm(pallet);
                upsertPalletLabelQueueEntry(pallet);
                saveState({ includeCache: true });
                saveLabelToolState();
                showMessage(ui.labelsMessage, `Loaded pallet ${pallet.palletCode}.`, "success");
            } catch (error) {
                showMessage(ui.labelsMessage, error.message, "error");
            }
        }

        function populatePalletLabelForm(pallet) {
            const entry = sanitizePalletLabelEntry(pallet);
            if (!entry) return;
            ui.palletLabelCode.value = entry.palletCode;
            ui.palletLabelAccount.value = entry.accountName;
            ui.palletLabelSku.value = entry.sku;
            ui.palletLabelDescription.value = entry.description || "";
            ui.palletLabelDescription.dataset.autofilled = entry.description ? "true" : "false";
            ui.palletLabelCases.value = entry.cases;
            ui.palletLabelDate.value = entry.date || todayInputValue();
            ui.palletLabelLocation.value = entry.location || "";
            persistPalletLabelDraft();
        }

        function resetPalletLabelForm() {
            ui.palletLabelCode.value = "";
            ui.palletLabelAccount.value = state.preferences.lastAccount || "";
            ui.palletLabelSku.value = "";
            ui.palletLabelDescription.value = "";
            ui.palletLabelDescription.dataset.autofilled = "false";
            ui.palletLabelCases.value = "";
            ui.palletLabelDate.value = todayInputValue();
            ui.palletLabelLocation.value = "";
            persistPalletLabelDraft();
            showMessage(ui.labelsMessage, "Ready for a new pallet label.", "info");
            if (ui.palletLabelCode) ui.palletLabelCode.focus();
        }

        async function savePalletLabelRecord(event, { printAfterSave = false } = {}) {
            if (event?.preventDefault) event.preventDefault();
            persistPalletLabelDraft();
            const entry = sanitizePalletLabelEntry({
                palletCode: ui.palletLabelCode.value,
                accountName: ui.palletLabelAccount.value,
                sku: ui.palletLabelSku.value,
                description: ui.palletLabelDescription.value,
                cases: ui.palletLabelCases.value,
                date: ui.palletLabelDate.value,
                location: ui.palletLabelLocation.value
            });

            if (!entry) {
                return fail(ui.labelsMessage, "Company, SKU, cases on pallet, and date are required for a pallet label.", ui.palletLabelAccount);
            }

            try {
                const payload = await requestJson("/api/pallets/save", {
                    method: "POST",
                    body: JSON.stringify(entry)
                });
                const saved = sanitizePalletLabelEntry(payload?.pallet);
                if (!saved) {
                    throw new Error("The saved pallet response was incomplete.");
                }

                const existingIndex = state.pallets.findIndex((pallet) => pallet.palletCode === saved.palletCode);
                if (existingIndex >= 0) state.pallets.splice(existingIndex, 1, saved);
                else state.pallets.unshift(saved);

                state.preferences.lastAccount = saved.accountName;
                if (saved.location) state.preferences.lastLocation = saved.location;
                upsertPalletLabelQueueEntry(saved);
                populatePalletLabelForm(saved);
                saveState({ includeCache: true });
                saveLabelToolState();
                await syncServerState(true);
                if (printAfterSave) {
                    printPalletLabels([saved]);
                }
                showMessage(
                    ui.labelsMessage,
                    `${entry.palletCode ? "Updated" : "Saved"} pallet ${saved.palletCode}${saved.location ? ` for ${saved.location}` : ""} and queued it for print.`,
                    "success"
                );
            } catch (error) {
                showMessage(ui.labelsMessage, error.message, "error");
            }
        }

        function upsertPalletLabelQueueEntry(entry) {
            const saved = sanitizePalletLabelEntry(entry);
            if (!saved) return;
            const existingIndex = labelToolState.palletLabels.findIndex((item) => item.palletCode === saved.palletCode);
            if (existingIndex >= 0) {
                labelToolState.palletLabels.splice(existingIndex, 1, saved);
            } else {
                labelToolState.palletLabels.unshift(saved);
            }
            saveLabelToolState();
            renderLabelTool();
        }

        function clearPalletLabels() {
            labelToolState.palletLabels = [];
            saveLabelToolState();
            renderLabelTool();
            showMessage(ui.labelsMessage, "Cleared the queued pallet labels for this device.", "info");
        }

        function getPalletLabelItems(accountName = "") {
            const owner = norm(accountName);
            if (!owner) return [];
            const itemMap = new Map();

            state.inventory
                .filter((line) => line.accountName === owner)
                .forEach((line) => {
                    const current = itemMap.get(line.sku) || {
                        sku: line.sku,
                        upc: line.upc || "",
                        description: getLineDescription(line),
                        quantity: 0,
                        trackingLevel: line.trackingLevel
                    };
                    current.quantity += Number(line.quantity) || 0;
                    if (!current.upc && line.upc) current.upc = line.upc;
                    if (!current.description) current.description = getLineDescription(line);
                    itemMap.set(line.sku, current);
                });

            state.masters.items
                .filter((item) => item.accountName === owner)
                .forEach((item) => {
                    if (!itemMap.has(item.sku)) {
                        itemMap.set(item.sku, {
                            sku: item.sku,
                            upc: item.upc || "",
                            description: item.description || "",
                            quantity: 0,
                            trackingLevel: item.trackingLevel
                        });
                    } else {
                        const current = itemMap.get(item.sku);
                        if (!current.upc && item.upc) current.upc = item.upc;
                        if (!current.description && item.description) current.description = item.description;
                    }
                });

            return [...itemMap.values()].sort((a, b) => a.sku.localeCompare(b.sku));
        }

        function buildPalletLabelMarkup(entry, { printable = false } = {}) {
            const saved = sanitizePalletLabelEntry(entry);
            if (!saved) return "";
            const trackingText = saved.inventoryQuantity
                ? formatTrackedQuantity(saved.inventoryQuantity, saved.inventoryTrackingLevel || "CASE")
                : "Not assigned";
            const barcodeMarkup = buildCode39Svg(saved.palletCode, printable ? { height: 54, narrow: 2, wide: 5 } : { height: 42, narrow: 2, wide: 4 });
            return `
                <div class="${printable ? "label-card" : "pallet-label-card"}">
                    <div class="pallet-print-label">
                        <div class="pallet-label-code-row">
                            <p class="pallet-label-code">${esc(saved.palletCode)}</p>
                            <span class="pallet-label-location">${esc(saved.location || "UNASSIGNED")}</span>
                        </div>
                        <div class="pallet-label-barcode">${barcodeMarkup}</div>
                        <p class="pallet-label-vendor">${esc(saved.accountName)}</p>
                        <p class="pallet-label-sku">${esc(saved.sku)}</p>
                        <p class="pallet-label-description">${esc(saved.description || "NO DESCRIPTION")}</p>
                        <div class="pallet-label-footer">
                            <div class="pallet-label-stat">
                                <span>Cases</span>
                                <strong>${esc(num(saved.cases))}</strong>
                            </div>
                            <div class="pallet-label-stat">
                                <span>System Qty</span>
                                <strong>${esc(trackingText)}</strong>
                            </div>
                            <div class="pallet-label-stat">
                                <span>Date</span>
                                <strong>${esc(formatLabelDate(saved.date))}</strong>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }

        function buildCode39Svg(value, { height = 42, narrow = 2, wide = 4, quiet = 12 } = {}) {
            const encoded = `*${String(value || "").trim().toUpperCase()}*`;
            if (!/^[0-9A-Z.\- $/+%*]+$/.test(encoded)) {
                return `<div class="meta">Barcode unavailable</div>`;
            }

            const modules = [];
            for (let index = 0; index < encoded.length; index += 1) {
                const pattern = code39PatternFor(encoded[index]);
                if (!pattern) {
                    return `<div class="meta">Barcode unavailable</div>`;
                }
                pattern.split("").forEach((token, patternIndex) => {
                    modules.push({
                        color: patternIndex % 2 === 0 ? "#111827" : "#ffffff",
                        width: token === "w" ? wide : narrow
                    });
                });
                if (index < encoded.length - 1) {
                    modules.push({ color: "#ffffff", width: narrow });
                }
            }

            const totalWidth = modules.reduce((sum, part) => sum + part.width, quiet * 2);
            let cursor = quiet;
            const bars = modules.map((part) => {
                const rect = `<rect x="${cursor}" y="0" width="${part.width}" height="${height}" fill="${part.color}" />`;
                cursor += part.width;
                return rect;
            }).join("");
            const textY = height + 16;

            return `
                <svg viewBox="0 0 ${totalWidth} ${height + 18}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${attr(value)} barcode">
                    <rect width="${totalWidth}" height="${height + 18}" fill="#ffffff" />
                    ${bars}
                    <text x="${totalWidth / 2}" y="${textY}" text-anchor="middle" font-size="12" font-family="monospace" fill="#111827">${esc(value)}</text>
                </svg>
            `;
        }

        function code39PatternFor(character) {
            const patterns = {
                "0": "nnnwwnwnn",
                "1": "wnnwnnnnw",
                "2": "nnwwnnnnw",
                "3": "wnwwnnnnn",
                "4": "nnnwwnnnw",
                "5": "wnnwwnnnn",
                "6": "nnwwwnnnn",
                "7": "nnnwnnwnw",
                "8": "wnnwnnwnn",
                "9": "nnwwnnwnn",
                "A": "wnnnnwnnw",
                "B": "nnwnnwnnw",
                "C": "wnwnnwnnn",
                "D": "nnnnwwnnw",
                "E": "wnnnwwnnn",
                "F": "nnwnwwnnn",
                "G": "nnnnnwwnw",
                "H": "wnnnnwwnn",
                "I": "nnwnnwwnn",
                "J": "nnnnwwwnn",
                "K": "wnnnnnnww",
                "L": "nnwnnnnww",
                "M": "wnwnnnnwn",
                "N": "nnnnwnnww",
                "O": "wnnnwnnwn",
                "P": "nnwnwnnwn",
                "Q": "nnnnnnwww",
                "R": "wnnnnnwwn",
                "S": "nnwnnnwwn",
                "T": "nnnnwnwwn",
                "U": "wwnnnnnnw",
                "V": "nwwnnnnnw",
                "W": "wwwnnnnnn",
                "X": "nwnnwnnnw",
                "Y": "wwnnwnnnn",
                "Z": "nwwnwnnnn",
                "-": "nwnnnnwnw",
                ".": "wwnnnnwnn",
                " ": "nwwnnnwnn",
                "$": "nwnwnwnnn",
                "/": "nwnwnnnwn",
                "+": "nwnnnwnwn",
                "%": "nnnwnwnwn",
                "*": "nwnnwnwnn"
            };
            return patterns[character] || "";
        }

        function getLocationLabelCandidates(filterText = "") {
            const filter = norm(filterText);
            const codeSet = new Set();
            const codes = [];
            const addCode = (rawCode) => {
                const normalized = normalizeLocationLabelCode(rawCode);
                if (!normalized || !isRackBinLabelCode(normalized) || codeSet.has(normalized)) return;
                if (filter && !normalized.includes(filter)) return;
                codeSet.add(normalized);
                codes.push(normalized);
            };

            state.masters.locations.forEach((entry) => addCode(entry.code));
            state.inventory.forEach((line) => addCode(line.location));
            state.batch.forEach((line) => addCode(line.location));
            return codes.sort((a, b) => a.localeCompare(b));
        }

        function buildRackBinLocationCode(rack, bin, level, side) {
            const safeRack = sanitizeLabelDigits(rack, 3);
            const safeBin = sanitizeLabelDigits(bin, 2);
            const safeLevel = String(sanitizeLabelLevel(level));
            const safeSide = sanitizeLabelSide(side);
            if (!safeRack || !safeBin) return "";
            return `${safeRack.padStart(3, "0")}-${safeBin.padStart(2, "0")}-${safeLevel}${safeSide}`;
        }

        function normalizeLocationLabelCode(code) {
            const cleaned = String(code || "").trim().toUpperCase().replace(/\s+/g, "");
            if (!cleaned) return "";
            const match = cleaned.match(/^(\d{1,3})-(\d{1,2})-(\d)(\d)$/);
            if (match) {
                return `${match[1].padStart(3, "0")}-${match[2].padStart(2, "0")}-${match[3]}${match[4]}`;
            }
            const generic = cleaned.replace(/[^A-Z0-9/_-]/g, "");
            return generic;
        }

        function isRackBinLabelCode(code) {
            return /^(\d{3})-(\d{2})-(\d)(\d)$/.test(String(code || ""));
        }

        function getLocationLabelDetails(code) {
            const normalized = normalizeLocationLabelCode(code);
            const match = normalized.match(/^(\d{3})-(\d{2})-(\d)(\d)$/);
            if (!match) {
                return { code: normalized, meta: "Location Label" };
            }
            return {
                code: normalized,
                meta: `Rack ${match[1]} | Bin ${match[2]} | Level ${match[3]} | Side ${match[4]}`
            };
        }

        function printLocationLabels() {
            if (labelToolState.mode === "pallet") {
                return printPalletLabels();
            }

            if (!labelToolState.labels.length) {
                showMessage(ui.labelsMessage, "Add at least one location label before printing.", "error");
                return;
            }

            const popup = window.open("", "_blank", "width=980,height=720");
            if (!popup) {
                showMessage(ui.labelsMessage, "Pop-up blocking prevented the label print preview from opening.", "error");
                return;
            }

            popup.document.write(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <title>Location Labels</title>
                    <style>
                        * { box-sizing: border-box; }
                        html, body {
                            background: #fff;
                            margin: 0;
                            padding: 0;
                            width: 6in;
                            height: 4in;
                            overflow: hidden;
                        }
                        .labels {
                            display: block;
                            width: 6in;
                        }
                        .label-card {
                            width: 6in;
                            height: 4in;
                            break-inside: avoid;
                            page-break-inside: avoid;
                            break-after: page;
                            page-break-after: always;
                            overflow: hidden;
                        }
                        .label-card:last-child {
                            break-after: auto;
                            page-break-after: auto;
                        }
                        .location-print-label {
                            width: 6in;
                            height: 4in;
                            margin: 0;
                            background: #fff;
                            overflow: hidden;
                            display: grid;
                            grid-template-rows: 1fr auto;
                            align-items: center;
                            justify-items: center;
                            padding: 0.16in 0.18in;
                            gap: 0.1in;
                            color: #111827;
                        }
                        .location-barcode-line {
                            width: 100%;
                            height: 1.45in;
                            background:
                                repeating-linear-gradient(
                                    to right,
                                    #000 0px,
                                    #000 4px,
                                    #fff 4px,
                                    #fff 9px,
                                    #000 9px,
                                    #000 12px,
                                    #fff 12px,
                                    #fff 18px,
                                    #000 18px,
                                    #000 24px,
                                    #fff 24px,
                                    #fff 29px,
                                    #000 29px,
                                    #000 32px,
                                    #fff 32px,
                                    #fff 39px
                                );
                        }
                        .location-label-code {
                            margin: 0;
                            width: 100%;
                            text-align: center;
                            font-size: 0.92in;
                            font-weight: 900;
                            letter-spacing: 0.02in;
                            line-height: 1;
                            white-space: nowrap;
                            overflow: hidden;
                        }
                        .location-label-code.compact { letter-spacing: 0.01in; font-size: 0.78in; }
                        .location-label-meta {
                            width: 100%;
                            margin-top: 0.05in;
                            text-align: center;
                            font-size: 0.15in;
                            font-weight: 700;
                            color: #374151;
                        }
                        @page {
                            size: 4in 6in landscape;
                            margin: 0;
                        }
                    </style>
                </head>
                <body>
                    <div class="labels">
                        ${labelToolState.labels.map((code) => {
                            const details = getLocationLabelDetails(code);
                            const compactClass = details.code.length > 11 ? " compact" : "";
                            return `
                                <div class="label-card">
                                    <div class="location-print-label">
                                        <div class="location-barcode-line"></div>
                                        <div>
                                            <p class="location-label-code${compactClass}">${esc(details.code)}</p>
                                            <div class="location-label-meta">${esc(details.meta)}</div>
                                        </div>
                                    </div>
                                </div>
                            `;
                        }).join("")}
                    </div>
                </body>
                </html>
            `);
            popup.document.close();
            popup.focus();
            setTimeout(() => popup.print(), 250);
        }

        function printPalletLabels(entries = labelToolState.palletLabels) {
            const printableEntries = Array.isArray(entries)
                ? entries.map(sanitizePalletLabelEntry).filter(Boolean)
                : [];

            if (!printableEntries.length) {
                showMessage(ui.labelsMessage, "Add at least one pallet label before printing.", "error");
                return;
            }

            const popup = window.open("", "_blank", "width=980,height=720");
            if (!popup) {
                showMessage(ui.labelsMessage, "Pop-up blocking prevented the pallet label print preview from opening.", "error");
                return;
            }

            popup.document.write(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <title>Pallet Labels</title>
                    <style>
                        * { box-sizing: border-box; }
                        html, body {
                            background: #fff;
                            margin: 0;
                            padding: 0;
                            width: 6in;
                            height: 4in;
                            overflow: hidden;
                            font-family: "Trebuchet MS", "Segoe UI", sans-serif;
                            color: #111827;
                        }
                        .labels { display: block; width: 6in; }
                        .label-card {
                            width: 6in;
                            height: 4in;
                            break-inside: avoid;
                            page-break-inside: avoid;
                            break-after: page;
                            page-break-after: always;
                            overflow: hidden;
                        }
                        .label-card:last-child {
                            break-after: auto;
                            page-break-after: auto;
                        }
                        .pallet-print-label {
                            width: 6in;
                            height: 4in;
                            margin: 0;
                            background: #fff;
                            overflow: hidden;
                            display: grid;
                            grid-template-rows: auto auto auto 1fr auto;
                            padding: 0.22in 0.24in;
                            gap: 0.12in;
                        }
                        .pallet-label-code-row {
                            display: flex;
                            justify-content: space-between;
                            gap: 0.16in;
                            align-items: baseline;
                        }
                        .pallet-label-code {
                            margin: 0;
                            font-size: 0.18in;
                            font-weight: 900;
                            letter-spacing: 0.05in;
                            text-transform: uppercase;
                        }
                        .pallet-label-location {
                            font-size: 0.14in;
                            font-weight: 800;
                            color: #4b5563;
                            text-transform: uppercase;
                            text-align: right;
                        }
                        .pallet-label-barcode {
                            width: 100%;
                            min-height: 0.7in;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                        }
                        .pallet-label-barcode svg {
                            width: 100%;
                            height: auto;
                            display: block;
                        }
                        .pallet-label-vendor {
                            margin: 0;
                            font-size: 0.32in;
                            font-weight: 900;
                            line-height: 1.05;
                            text-transform: uppercase;
                        }
                        .pallet-label-sku {
                            margin: 0;
                            font-size: 0.72in;
                            font-weight: 900;
                            line-height: 0.95;
                            letter-spacing: 0.03in;
                            text-transform: uppercase;
                            word-break: break-word;
                        }
                        .pallet-label-description {
                            margin: 0;
                            font-size: 0.24in;
                            line-height: 1.25;
                            color: #374151;
                            overflow: hidden;
                        }
                        .pallet-label-footer {
                            display: grid;
                            grid-template-columns: repeat(3, minmax(0, 1fr));
                            gap: 0.18in;
                            align-items: stretch;
                        }
                        .pallet-label-stat {
                            padding: 0.12in 0.14in;
                            border-radius: 0.12in;
                            background: #f5f8fb;
                            border: 1px solid #d7e0e8;
                            display: grid;
                            gap: 0.04in;
                        }
                        .pallet-label-stat span {
                            font-size: 0.12in;
                            font-weight: 800;
                            letter-spacing: 0.03in;
                            text-transform: uppercase;
                            color: #6b7280;
                        }
                        .pallet-label-stat strong {
                            font-size: 0.24in;
                            line-height: 1.1;
                        }
                        @page {
                            size: 4in 6in landscape;
                            margin: 0;
                        }
                    </style>
                </head>
                <body>
                    <div class="labels">
                        ${printableEntries.map((entry) => buildPalletLabelMarkup(entry, { printable: true })).join("")}
                    </div>
                </body>
                </html>
            `);
            popup.document.close();
            popup.focus();
            setTimeout(() => popup.print(), 250);
        }

        function exportLocationLabelCodesCsv() {
            if (labelToolState.mode === "pallet") {
                if (!labelToolState.palletLabels.length) {
                    showMessage(ui.labelsMessage, "Add at least one pallet label before exporting.", "error");
                    return;
                }
                const rows = [["PALLET_ID", "VENDOR_CUSTOMER", "LOCATION", "SKU", "DESCRIPTION", "CASES_ON_PALLET", "TRACKING", "SYSTEM_QTY", "DATE"]]
                    .concat(labelToolState.palletLabels.map((entry) => [
                        entry.palletCode,
                        entry.accountName,
                        entry.location || "",
                        entry.sku,
                        entry.description,
                        entry.cases,
                        trackingLabel(entry.inventoryTrackingLevel || "CASE"),
                        entry.inventoryQuantity,
                        entry.date
                    ]));
                downloadBlob(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `wms365-scanner-pallet-labels-${fileStamp()}.csv`, "text/csv;charset=utf-8");
                showMessage(ui.labelsMessage, "Pallet labels exported.", "success");
                return;
            }

            if (!labelToolState.labels.length) {
                showMessage(ui.labelsMessage, "Add at least one location label before exporting codes.", "error");
                return;
            }
            const rows = [["CODE", "META"]].concat(labelToolState.labels.map((code) => {
                const details = getLocationLabelDetails(code);
                return [details.code, details.meta];
            }));
            downloadBlob(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `wms365-scanner-location-labels-${fileStamp()}.csv`, "text/csv;charset=utf-8");
            showMessage(ui.labelsMessage, "Location label codes exported.", "success");
        }

        function sanitizeLabelDigits(value, maxLength) {
            return String(value || "").replace(/\D+/g, "").slice(0, maxLength);
        }

        function sanitizeLabelLevel(value) {
            const parsed = Number.parseInt(String(value || ""), 10);
            return Number.isFinite(parsed) && parsed >= 1 && parsed <= 9 ? parsed : 1;
        }

        function sanitizeLabelSide(value) {
            return String(value || "1") === "2" ? "2" : "1";
        }

        function todayInputValue() {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, "0");
            const day = String(now.getDate()).padStart(2, "0");
            return `${year}-${month}-${day}`;
        }

        function normalizeLabelDate(value) {
            const text = String(value || "").trim();
            return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
        }

        function formatLabelDate(value) {
            const normalized = normalizeLabelDate(value);
            if (!normalized) return "";
            try {
                return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(`${normalized}T00:00:00`));
            } catch {
                return normalized;
            }
        }

        function sanitizePalletLabelEntry(entry) {
            const palletCode = norm(entry?.palletCode || entry?.code || entry?.palletId || entry?.pallet_id) || makeId("PLT").toUpperCase();
            const accountName = norm(entry?.accountName || entry?.owner || entry?.vendor || entry?.customer);
            const sku = norm(entry?.sku);
            const cases = toPositiveInt(entry?.cases ?? entry?.casesOnPallet);
            const date = normalizeLabelDate(entry?.date) || todayInputValue();
            if (!accountName || !sku || !cases || !date) return null;
            return {
                id: typeof entry?.id === "string" ? entry.id : makeId("pallet-label"),
                palletCode,
                accountName,
                sku,
                upc: norm(entry?.upc || ""),
                description: String(entry?.description || "").trim().replace(/\s+/g, " "),
                cases,
                date,
                location: norm(entry?.location || ""),
                inventoryTrackingLevel: normalizeTrackingLevel(entry?.inventoryTrackingLevel || entry?.trackingLevel || "CASE"),
                inventoryQuantity: toPositiveInt(entry?.inventoryQuantity) || cases
            };
        }

        async function saveMasterOwner(event) {
            event.preventDefault();
            const entry = sanitizeMasterOwner({
                name: ui.masterOwnerName.value,
                legalName: ui.masterOwnerLegalName.value,
                accountCode: ui.masterOwnerCode.value,
                contactName: ui.masterOwnerContactName.value,
                contactTitle: ui.masterOwnerContactTitle.value,
                email: ui.masterOwnerEmail.value,
                phone: ui.masterOwnerPhone.value,
                mobile: ui.masterOwnerMobile.value,
                website: ui.masterOwnerWebsite.value,
                billingEmail: ui.masterOwnerBillingEmail.value,
                apEmail: ui.masterOwnerApEmail.value,
                portalLoginEmail: ui.masterOwnerPortalEmail.value,
                address1: ui.masterOwnerAddress1.value,
                address2: ui.masterOwnerAddress2.value,
                city: ui.masterOwnerCity.value,
                state: ui.masterOwnerState.value,
                postalCode: ui.masterOwnerPostalCode.value,
                country: ui.masterOwnerCountry.value,
                isActive: ui.masterOwnerActive.value !== "false",
                note: ui.masterOwnerNote.value
            });
            if (!entry?.name) return fail(ui.catalogMessage, "Enter a company name to save.", ui.masterOwnerName);

            try {
                await requestJson("/api/master-owner", {
                    method: "POST",
                    body: JSON.stringify(entry)
                });
                await syncServerState(true);
                setActiveCompany(entry.name, { force: true, rerender: false });
                ui.scanAccount.value = entry.name;
                ui.masterItemAccount.value = entry.name;
                ui.portalAccessAccount.value = entry.name;
                if (entry.portalLoginEmail) ui.portalAccessEmail.value = entry.portalLoginEmail;
                showMessage(ui.catalogMessage, `Saved company ${entry.name}${entry.portalLoginEmail ? ` with linked portal email ${entry.portalLoginEmail}` : ""}.`, "success");
                document.getElementById("masterOwnerForm").reset();
                ui.masterOwnerActive.value = "true";
                ui.masterOwnerName.focus();
            } catch (error) {
                showMessage(ui.catalogMessage, error.message, "error");
            }
        }

        function loadOwnerProfile(owner) {
            const entry = sanitizeMasterOwner(owner);
            if (!entry) return;
            setActiveCompany(entry.name, { force: true, rerender: false });
            ui.masterOwnerName.value = entry.name;
            ui.masterOwnerLegalName.value = entry.legalName || "";
            ui.masterOwnerCode.value = entry.accountCode || "";
            ui.masterOwnerActive.value = entry.isActive === false ? "false" : "true";
            ui.masterOwnerContactName.value = entry.contactName || "";
            ui.masterOwnerContactTitle.value = entry.contactTitle || "";
            ui.masterOwnerEmail.value = entry.email || "";
            ui.masterOwnerPhone.value = entry.phone || "";
            ui.masterOwnerMobile.value = entry.mobile || "";
            ui.masterOwnerWebsite.value = entry.website || "";
            ui.masterOwnerBillingEmail.value = entry.billingEmail || "";
            ui.masterOwnerApEmail.value = entry.apEmail || "";
            ui.masterOwnerPortalEmail.value = entry.portalLoginEmail || "";
            ui.masterOwnerAddress1.value = entry.address1 || "";
            ui.masterOwnerAddress2.value = entry.address2 || "";
            ui.masterOwnerCity.value = entry.city || "";
            ui.masterOwnerState.value = entry.state || "";
            ui.masterOwnerPostalCode.value = entry.postalCode || "";
            ui.masterOwnerCountry.value = entry.country || "";
            ui.masterOwnerNote.value = entry.note || "";
        }

        function loadVendorToPortalAccess() {
            const entry = sanitizeMasterOwner({
                name: ui.masterOwnerName.value,
                portalLoginEmail: ui.masterOwnerPortalEmail.value,
                email: ui.masterOwnerEmail.value,
                isActive: ui.masterOwnerActive.value !== "false"
            });
            if (!entry?.name) return fail(ui.portalAccessMessage, "Enter or load a company profile first.", ui.masterOwnerName);
            ui.portalAccessId.value = "";
            ui.portalAccessAccount.value = entry.name;
            setActiveCompany(entry.name, { force: true, rerender: false });
            ui.portalAccessEmail.value = entry.portalLoginEmail || entry.email || "";
            ui.portalAccessActive.value = entry.isActive === false ? "false" : "true";
            ui.portalAccessPassword.focus();
            showMessage(ui.portalAccessMessage, `Loaded ${entry.name} into portal access.${ui.portalAccessEmail.value ? ` Linked email ${ui.portalAccessEmail.value}.` : " Add the login email and password."}`, "info");
        }

        function resetPortalAccessForm({ keepCompany = false } = {}) {
            const company = keepCompany ? getScopedCompanyValue(ui.portalAccessAccount.value) : "";
            ui.portalAccessId.value = "";
            ui.portalAccessPassword.value = "";
            ui.portalAccessEmail.value = "";
            ui.portalAccessActive.value = "true";
            if (keepCompany) {
                ui.portalAccessAccount.value = company;
                ui.portalAccessEmail.focus();
            } else {
                ui.portalAccessAccount.value = "";
                ui.portalAccessAccount.focus();
            }
        }

        function loadVendorToBilling() {
            const entry = sanitizeMasterOwner({
                name: ui.masterOwnerName.value,
                billingEmail: ui.masterOwnerBillingEmail.value
            });
            if (!entry?.name) return fail(ui.billingMessage, "Enter or load a company profile first.", ui.masterOwnerName);
            ui.billingOwner.value = entry.name;
            setActiveCompany(entry.name, { force: true, rerender: false });
            billingRateDrafts.delete(entry.name);
            renderBilling();
            setSection("billing");
            showMessage(ui.billingMessage, `Loaded ${entry.name} into warehouse billing.`, "info");
        }

        function onBillingOwnerInput() {
            const owner = getScopedCompanyValue(ui.billingOwner.value);
            if (owner) {
                setActiveCompany(owner, { force: true, rerender: false });
            }
            syncManualBillingFeeDefaults();
            renderBilling();
        }

        function getBillingFeeCatalogRows() {
            return [...(state.billing?.feeCatalog || [])].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
        }

        function getOwnerBillingRateLookup(accountName) {
            const owner = norm(accountName);
            return new Map((state.billing?.ownerRates || [])
                .filter((entry) => entry.accountName === owner)
                .map((entry) => [entry.feeCode, entry]));
        }

        function getBillingDraftForOwner(accountName) {
            const owner = norm(accountName);
            if (!owner) return new Map();
            if (billingRateDrafts.has(owner)) return billingRateDrafts.get(owner);

            const savedRates = getOwnerBillingRateLookup(owner);
            const draft = new Map(getBillingFeeCatalogRows().map((fee) => {
                const saved = savedRates.get(fee.code);
                return [fee.code, {
                    feeCode: fee.code,
                    rate: saved ? toNumber(saved.rate) : toNumber(fee.defaultRate),
                    isEnabled: saved ? saved.isEnabled === true : false,
                    unitLabel: saved?.unitLabel || fee.unitLabel || "",
                    note: saved?.note || ""
                }];
            }));
            billingRateDrafts.set(owner, draft);
            return draft;
        }

        function getEffectiveBillingRows(owner, filterText = "") {
            const query = norm(filterText);
            const draft = getBillingDraftForOwner(owner);
            return getBillingFeeCatalogRows()
                .map((fee) => {
                    const saved = draft.get(fee.code) || {
                        feeCode: fee.code,
                        rate: toNumber(fee.defaultRate),
                        isEnabled: false,
                        unitLabel: fee.unitLabel || "",
                        note: ""
                    };
                    return {
                        ...fee,
                        rate: toNumber(saved.rate),
                        isEnabled: saved.isEnabled === true,
                        unitLabel: saved.unitLabel || fee.unitLabel || "",
                        note: saved.note || ""
                    };
                })
                .filter((row) => !query
                    || row.code.includes(query)
                    || norm(row.name).includes(query)
                    || norm(row.category).includes(query)
                );
        }

        function getFilteredBillingEvents() {
            const ownerFilter = getScopedCompanyValue(ui.billingOwner.value);
            const statusFilter = norm(ui.billingStatusFilter.value || "OPEN");
            const search = norm(ui.billingEventFilter.value);
            const from = ui.billingFromDate.value || "";
            const to = ui.billingToDate.value || "";

            return [...(state.billing?.events || [])]
                .filter((event) => !ownerFilter || event.accountName === ownerFilter)
                .filter((event) => statusFilter === "ALL" ? true : event.status === statusFilter)
                .filter((event) => !from || event.serviceDate >= from)
                .filter((event) => !to || event.serviceDate <= to)
                .filter((event) => !search || [
                    event.feeName,
                    event.feeCode,
                    event.reference,
                    event.sourceRef,
                    event.sourceType,
                    event.note,
                    event.invoiceNumber
                ].some((value) => norm(value).includes(search)))
                .sort((a, b) => String(b.serviceDate).localeCompare(String(a.serviceDate)) || Number(b.id) - Number(a.id));
        }

        function renderBilling() {
            const owner = getScopedCompanyValue(ui.billingOwner.value);
            const feeRows = owner ? getEffectiveBillingRows(owner, ui.billingFeeFilter.value) : [];
            const filteredEvents = getFilteredBillingEvents();
            const allOwnerEvents = owner
                ? (state.billing?.events || []).filter((event) => event.accountName === owner)
                : (state.billing?.events || []);
            const openEvents = allOwnerEvents.filter((event) => event.status === "OPEN");
            const activeFees = owner ? getEffectiveBillingRows(owner).filter((row) => row.isEnabled).length : 0;
            const openAmount = openEvents.reduce((sum, event) => sum + toNumber(event.amount), 0);
            const filteredAmount = filteredEvents.reduce((sum, event) => sum + toNumber(event.amount), 0);

            ui.billingActiveFeeCount.textContent = num(activeFees);
            ui.billingOpenLineCount.textContent = num(openEvents.length);
            ui.billingOpenAmount.textContent = money(openAmount);
            ui.billingFilteredAmount.textContent = money(filteredAmount);
            ui.billingRatesMeta.textContent = owner ? `${num(feeRows.length)} fee${feeRows.length === 1 ? "" : "s"}` : "Choose a company";

            renderBillingFeeOptions(owner);

            if (!owner) {
                ui.billingRatesEmpty.textContent = "Choose a company to assign warehouse billing rates.";
                ui.billingRatesEmpty.classList.remove("hidden");
                ui.billingRatesWrap.classList.add("hidden");
                ui.billingRatesBody.innerHTML = "";
                ui.billingManualFeeMeta.textContent = "Choose a company and fee to add a manual billing line.";
            } else if (!feeRows.length) {
                ui.billingRatesEmpty.classList.remove("hidden");
                ui.billingRatesWrap.classList.add("hidden");
                ui.billingRatesBody.innerHTML = "";
                ui.billingRatesEmpty.textContent = "No fee rows match the current fee filter.";
            } else {
                ui.billingRatesEmpty.classList.add("hidden");
                ui.billingRatesWrap.classList.remove("hidden");
                ui.billingRatesBody.innerHTML = feeRows.map((row) => `
                    <tr data-billing-fee-code="${attr(row.code)}">
                        <td><input class="billing-rate-toggle" type="checkbox" data-billing-enabled ${row.isEnabled ? "checked" : ""}></td>
                        <td>${esc(row.category)}</td>
                        <td>
                            <div class="billing-fee-name">
                                <strong>${esc(row.name)}</strong>
                                <span class="billing-fee-code">${esc(row.code)}</span>
                            </div>
                        </td>
                        <td><input type="text" data-billing-unit value="${attr(row.unitLabel || "")}" placeholder="Unit"></td>
                        <td><input type="number" min="0" step="0.0001" data-billing-rate value="${attr(toNumber(row.rate))}" placeholder="0.00"></td>
                        <td><input type="text" data-billing-note value="${attr(row.note || "")}" placeholder="Optional note"></td>
                    </tr>
                `).join("");
            }

            ui.billingEventsMeta.textContent = `${num(filteredEvents.length)} line${filteredEvents.length === 1 ? "" : "s"}`;
            if (!filteredEvents.length) {
                ui.billingEventsEmpty.classList.remove("hidden");
                ui.billingEventsWrap.classList.add("hidden");
                ui.billingEventsBody.innerHTML = "";
            } else {
                ui.billingEventsEmpty.classList.add("hidden");
                ui.billingEventsWrap.classList.remove("hidden");
                ui.billingEventsBody.innerHTML = filteredEvents.map((event) => `
                    <tr>
                        <td>${esc(formatDate(event.serviceDate))}</td>
                        <td>${esc(event.accountName)}</td>
                        <td class="sheet-wrap">${esc(event.feeName || event.feeCode)}</td>
                        <td>${esc(formatDecimal(event.quantity))}</td>
                        <td class="billing-money">${esc(money(event.rate))}</td>
                        <td class="billing-money">${esc(money(event.amount))}</td>
                        <td>${esc(event.status)}</td>
                        <td>${esc(event.invoiceNumber || "-")}</td>
                        <td class="sheet-wrap">${esc(event.reference || "-")}</td>
                        <td>${esc(event.sourceType || "-")}${event.sourceRef ? `<br><span class="meta">${esc(event.sourceRef)}</span>` : ""}</td>
                        <td class="sheet-wrap">${esc(event.note || "-")}</td>
                    </tr>
                `).join("");
            }

            syncManualBillingFeeDefaults();
        }

        function renderBillingFeeOptions(owner) {
            const ownerName = norm(owner);
            const enabledRows = ownerName ? getEffectiveBillingRows(ownerName).filter((row) => row.isEnabled) : [];
            const rows = enabledRows.length ? enabledRows : getBillingFeeCatalogRows();
            const currentValue = ui.billingManualFeeCode.value;
            ui.billingManualFeeCode.innerHTML = `<option value="">Choose a fee</option>${rows.map((row) => `
                <option value="${attr(row.code)}">${esc(`${row.category} - ${row.name}`)}</option>
            `).join("")}`;
            if ([...ui.billingManualFeeCode.options].some((option) => option.value === currentValue)) {
                ui.billingManualFeeCode.value = currentValue;
            }
        }

        function onBillingRateDraftChange(event) {
            const row = event.target.closest("[data-billing-fee-code]");
            if (!row) return;
            const owner = getScopedCompanyValue(ui.billingOwner.value);
            if (!owner) return;
            const feeCode = row.dataset.billingFeeCode || "";
            const draft = getBillingDraftForOwner(owner);
            draft.set(feeCode, {
                feeCode,
                isEnabled: row.querySelector("[data-billing-enabled]")?.checked === true,
                unitLabel: String(row.querySelector("[data-billing-unit]")?.value || "").trim(),
                rate: toNumber(row.querySelector("[data-billing-rate]")?.value),
                note: String(row.querySelector("[data-billing-note]")?.value || "").trim()
            });
            if (event.target === ui.billingManualFeeCode) {
                syncManualBillingFeeDefaults();
            }
        }

        async function saveBillingRates() {
            const owner = getScopedCompanyValue(ui.billingOwner.value);
            if (!owner) return fail(ui.billingMessage, "Choose the company first.", ui.billingOwner);
            const draft = [...getBillingDraftForOwner(owner).values()].map((entry) => ({
                accountName: owner,
                feeCode: entry.feeCode,
                rate: toNumber(entry.rate),
                isEnabled: entry.isEnabled === true,
                unitLabel: String(entry.unitLabel || "").trim(),
                note: String(entry.note || "").trim()
            }));

            try {
                await requestJson("/api/billing/rates", {
                    method: "POST",
                    body: JSON.stringify({ accountName: owner, rates: draft })
                });
                billingRateDrafts.delete(owner);
                await syncServerState(true);
                showMessage(ui.billingMessage, `Saved billing fee setup for ${owner}.`, "success");
            } catch (error) {
                showMessage(ui.billingMessage, error.message, "error");
            }
        }

        function getSelectedBillingFee(owner, feeCode) {
            const code = norm(feeCode);
            if (!code) return null;
            return getEffectiveBillingRows(owner).find((row) => row.code === code) || null;
        }

        function syncManualBillingFeeDefaults() {
            const owner = getScopedCompanyValue(ui.billingOwner.value);
            const fee = getSelectedBillingFee(owner, ui.billingManualFeeCode.value);
            if (!owner) {
                ui.billingManualFeeMeta.textContent = "Choose a company and fee to add a manual billing line.";
                return;
            }
            if (!fee) {
                ui.billingManualFeeMeta.textContent = "Choose a fee to add a manual billing line.";
                return;
            }
            ui.billingManualRate.value = String(toNumber(fee.rate || fee.defaultRate));
            ui.billingManualFeeMeta.textContent = `${fee.name} | ${fee.unitLabel || "No unit label"} | ${fee.isEnabled ? "Enabled" : "Disabled for this company"}`;
        }

        async function saveManualBillingEvent(event) {
            event.preventDefault();
            const owner = getScopedCompanyValue(ui.billingOwner.value);
            const feeCode = norm(ui.billingManualFeeCode.value);
            const quantity = toNumber(ui.billingManualQuantity.value);
            if (!owner) return fail(ui.billingMessage, "Choose the company first.", ui.billingOwner);
            if (!feeCode) return fail(ui.billingMessage, "Choose a fee first.", ui.billingManualFeeCode);
            if (!(quantity > 0)) return fail(ui.billingMessage, "Enter a billing quantity greater than zero.", ui.billingManualQuantity);

            try {
                await requestJson("/api/billing/events/manual", {
                    method: "POST",
                    body: JSON.stringify({
                        accountName: owner,
                        feeCode,
                        quantity,
                        rate: ui.billingManualRate.value,
                        serviceDate: ui.billingManualDate.value,
                        reference: ui.billingManualReference.value,
                        note: ui.billingManualNote.value
                    })
                });
                ui.billingManualQuantity.value = "";
                ui.billingManualReference.value = "";
                ui.billingManualNote.value = "";
                await syncServerState(true);
                showMessage(ui.billingMessage, `Added manual billing line for ${owner}.`, "success");
            } catch (error) {
                showMessage(ui.billingMessage, error.message, "error");
            }
        }

        async function generateStorageBilling() {
            const owner = getScopedCompanyValue(ui.billingOwner.value);
            const month = ui.billingStorageMonth.value;
            if (!owner) return fail(ui.billingMessage, "Choose the company first.", ui.billingOwner);
            if (!month) return fail(ui.billingMessage, "Choose a storage month first.", ui.billingStorageMonth);

            try {
                await requestJson("/api/billing/storage-accrual", {
                    method: "POST",
                    body: JSON.stringify({ accountName: owner, month })
                });
                await syncServerState(true);
                showMessage(ui.billingMessage, `Generated storage billing for ${owner} for ${month}.`, "success");
            } catch (error) {
                showMessage(ui.billingMessage, error.message, "error");
            }
        }

        async function markFilteredBillingInvoiced() {
            const invoiceNumber = String(ui.billingInvoiceNumber.value || "").trim();
            const openIds = getFilteredBillingEvents().filter((event) => event.status === "OPEN").map((event) => event.id);
            if (!invoiceNumber) return fail(ui.billingMessage, "Enter the invoice number first.", ui.billingInvoiceNumber);
            if (!openIds.length) return fail(ui.billingMessage, "No open billing lines match the current filter.", ui.billingStatusFilter);

            try {
                await requestJson("/api/billing/events/mark-invoiced", {
                    method: "POST",
                    body: JSON.stringify({ ids: openIds, invoiceNumber })
                });
                await syncServerState(true);
                showMessage(ui.billingMessage, `Marked ${num(openIds.length)} billing line${openIds.length === 1 ? "" : "s"} invoiced under ${invoiceNumber}.`, "success");
            } catch (error) {
                showMessage(ui.billingMessage, error.message, "error");
            }
        }

        async function exportBillingDetailCsv() {
            try {
                await syncServerState(true);
                const rows = [["Service Date", "Company", "Fee Code", "Fee Name", "Category", "Quantity", "Unit", "Rate", "Amount", "Status", "Invoice Number", "Reference", "Source Type", "Source Ref", "Note"]]
                    .concat(getFilteredBillingEvents().map((event) => [
                        event.serviceDate,
                        event.accountName,
                        event.feeCode,
                        event.feeName || "",
                        event.feeCategory || "",
                        String(event.quantity),
                        event.unitLabel || "",
                        String(event.rate),
                        String(event.amount),
                        event.status,
                        event.invoiceNumber || "",
                        event.reference || "",
                        event.sourceType || "",
                        event.sourceRef || "",
                        event.note || ""
                    ]));
                downloadBlob(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `wms365-scanner-billing-detail-${fileStamp()}.csv`, "text/csv;charset=utf-8");
                showMessage(ui.billingMessage, "Billing detail CSV exported.", "success");
            } catch (error) {
                showMessage(ui.billingMessage, error.message, "error");
            }
        }

        async function exportBillingZohoCsv() {
            try {
                await syncServerState(true);
                const ownerByName = new Map((state.masters.ownerRecords || []).map((ownerEntry) => [ownerEntry.name, ownerEntry]));
                const rows = [["Company Name", "Billing Email", "Invoice Number", "Invoice Date", "Service Date", "Item Name", "Description", "Quantity", "Rate", "Amount", "Reference", "Source", "Status"]]
                    .concat(getFilteredBillingEvents().map((event) => {
                        const owner = ownerByName.get(event.accountName);
                        return [
                            event.accountName,
                            owner?.billingEmail || owner?.email || "",
                            event.invoiceNumber || "",
                            event.invoicedAt ? event.invoicedAt.slice(0, 10) : "",
                            event.serviceDate,
                            event.feeName || event.feeCode,
                            event.note || event.feeCategory || "",
                            String(event.quantity),
                            String(event.rate),
                            String(event.amount),
                            event.reference || "",
                            [event.sourceType, event.sourceRef].filter(Boolean).join(" | "),
                            event.status
                        ];
                    }));
                downloadBlob(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `wms365-scanner-zoho-billing-${fileStamp()}.csv`, "text/csv;charset=utf-8");
                showMessage(ui.billingMessage, "Zoho billing CSV exported.", "success");
            } catch (error) {
                showMessage(ui.billingMessage, error.message, "error");
            }
        }

        async function savePortalAccess(event) {
            event.preventDefault();
            const accessId = norm(ui.portalAccessId.value);
            const accountName = getScopedCompanyValue(ui.portalAccessAccount.value);
            const linkedOwner = (state.masters.ownerRecords || []).find((owner) => owner.name === accountName);
            const email = norm(String(ui.portalAccessEmail.value || linkedOwner?.portalLoginEmail || linkedOwner?.email || "").toLowerCase());
            const password = String(ui.portalAccessPassword.value || "");
            const isActive = ui.portalAccessActive.value !== "false";

            if (!accountName) {
                return fail(ui.portalAccessMessage, "Choose the company for this portal login.", ui.portalAccessAccount);
            }
            if (!email) {
                return fail(ui.portalAccessMessage, "Enter the login email address for this company portal user.", ui.portalAccessEmail);
            }
            const existingByEmail = portalAccessRecords.find((entry) => entry.email === email);
            if (!password && !accessId && !existingByEmail) {
                return fail(ui.portalAccessMessage, "Set a password the first time you add this portal user.", ui.portalAccessPassword);
            }

            try {
                const response = await requestJson("/api/admin/portal-access", {
                    method: "POST",
                    body: JSON.stringify({ accessId, accountName, email, password, isActive })
                });
                setActiveCompany(accountName, { force: true, rerender: false });
                ui.scanAccount.value = accountName;
                ui.masterItemAccount.value = accountName;
                ui.portalAccessId.value = response?.access?.id || accessId || "";
                ui.portalAccessEmail.value = email;
                ui.portalAccessPassword.value = "";
                await refreshPortalAccessList();
                showMessage(ui.portalAccessMessage, `${response?.wasCreated ? "Added" : "Updated"} portal user ${email} for ${accountName}${password ? " with a new password" : ""}.`, "success");
            } catch (error) {
                showMessage(ui.portalAccessMessage, error.message, "error");
            }
        }

        async function refreshPortalAccessList() {
            try {
                const payload = await requestJson("/api/admin/portal-access");
                portalAccessRecords = Array.isArray(payload?.access)
                    ? payload.access.map(sanitizePortalAccessRecord).filter(Boolean)
                    : [];
                renderPortalAccessList();
            } catch (error) {
                portalAccessRecords = [];
                renderPortalAccessList(error.message);
                throw error;
            }
        }

        function renderPortalAccessList(errorText = "") {
            const company = getActiveCompany();
            const visibleAccess = company
                ? portalAccessRecords.filter((entry) => entry.accountName === company)
                : portalAccessRecords;
            ui.portalAccessCount.textContent = `${num(visibleAccess.length)} user${visibleAccess.length === 1 ? "" : "s"}`;

            if (!visibleAccess.length) {
                ui.portalAccessList.innerHTML = `<p class="empty">${esc(errorText || "No portal users saved yet.")}</p>`;
                return;
            }

            ui.portalAccessList.innerHTML = visibleAccess.map((entry) => `
                <div class="quick-row">
                    <div class="quick-main">
                        <strong>${esc(entry.email || entry.accountName)}</strong>
                        <div class="quick-meta">
                            ${esc(entry.accountName)} | ${entry.isActive ? "Portal active" : "Portal disabled"}${entry.lastLoginAt ? ` | Last login ${esc(formatDate(entry.lastLoginAt))}` : " | No portal login yet"}
                        </div>
                    </div>
                    <button class="btn ghost mini" type="button" data-edit-portal-access="${attr(entry.id)}">Load</button>
                </div>
            `).join("");
        }

        function onPortalAccessListClick(event) {
            const editButton = event.target.closest("[data-edit-portal-access]");
            if (!editButton) return;
            const accessId = editButton.dataset.editPortalAccess || "";
            const match = portalAccessRecords.find((entry) => entry.id === accessId);
            if (!match) return;
            const accountName = match.accountName;
            setActiveCompany(accountName, { force: true, rerender: false });
            ui.portalAccessId.value = match.id || "";
            ui.portalAccessAccount.value = accountName;
            const owner = (state.masters.ownerRecords || []).find((entry) => entry.name === accountName);
            ui.portalAccessEmail.value = match?.email || owner?.portalLoginEmail || owner?.email || "";
            ui.portalAccessActive.value = match?.isActive === false ? "false" : (owner?.isActive === false ? "false" : "true");
            ui.portalAccessPassword.value = "";
            if (owner) loadOwnerProfile(owner);
            ui.portalAccessPassword.focus();
        }

        async function refreshPortalOrdersList(silent = false) {
            try {
                const company = getActiveCompany();
                const query = company ? `?accountName=${encodeURIComponent(company)}` : "";
                let payload = await requestJson(`/api/admin/portal-orders${query}`);
                let orders = Array.isArray(payload?.orders)
                    ? payload.orders.map(sanitizePortalOrderRecord).filter(Boolean)
                    : [];

                if (!orders.length && company) {
                    const fallbackPayload = await requestJson(`/api/admin/portal-orders`);
                    const fallbackOrders = Array.isArray(fallbackPayload?.orders)
                        ? fallbackPayload.orders.map(sanitizePortalOrderRecord).filter(Boolean)
                        : [];
                    orders = fallbackOrders.filter((order) => norm(order.accountName) === norm(company));
                }

                portalOrderRecords = orders;
                renderPortalOrdersList();
            } catch (error) {
                if (!silent) {
                    portalOrderRecords = [];
                    renderPortalOrdersList(error.message);
                }
                throw error;
            }
        }

        function getFilteredPortalOrders() {
            const company = getActiveCompany();
            const statusFilter = norm(ui.portalOrderStatusFilter?.value || "");
            const query = norm(ui.portalOrderSearch?.value || "");
            return portalOrderRecords.filter((order) => {
                if (company && order.accountName !== company) return false;
                if (statusFilter && norm(order.status) !== statusFilter) return false;
                if (!query) return true;
                const haystack = [
                    order.orderCode,
                    order.accountName,
                    order.poNumber,
                    order.shippingReference,
                    order.contactName,
                    order.shipToName,
                    order.shipToAddress1,
                    order.shipToCity,
                    order.shipToState,
                    order.shipToPostalCode,
                    order.orderNotes,
                    ...(Array.isArray(order.lines) ? order.lines.flatMap((line) => [
                        line.sku,
                        line.description,
                        String(line.quantity),
                        String(line.availableQuantity),
                        ...(Array.isArray(line.pickLocations) ? line.pickLocations.map((entry) => entry.location) : [])
                    ]) : [])
                ].map((value) => norm(value || "")).join(" ");
                return haystack.includes(query);
            });
        }

        function renderPortalOrderSummary(orders) {
            const released = orders.filter((order) => order.status === "RELEASED").length;
            const picked = orders.filter((order) => order.status === "PICKED").length;
            const staged = orders.filter((order) => order.status === "STAGED").length;
            const shipped = orders.filter((order) => order.status === "SHIPPED").length;
            if (ui.salesOrderReleasedCount) ui.salesOrderReleasedCount.textContent = num(released);
            if (ui.salesOrderPickedCount) ui.salesOrderPickedCount.textContent = num(picked);
            if (ui.salesOrderStagedCount) ui.salesOrderStagedCount.textContent = num(staged);
            if (ui.salesOrderShippedCount) ui.salesOrderShippedCount.textContent = num(shipped);
        }

        function renderPortalOrdersList(errorText = "") {
            const visibleOrders = getFilteredPortalOrders();
            ui.portalOrdersMeta.textContent = `${num(visibleOrders.length)} order${visibleOrders.length === 1 ? "" : "s"}`;
            renderPortalOrderSummary(visibleOrders);

            if (!visibleOrders.length) {
                const company = getActiveCompany();
                const fallback = errorText || (company
                    ? "No sales orders match the current company and order filters."
                    : "Choose a company to review released sales orders.");
                ui.portalOrdersList.innerHTML = `<p class="empty">${esc(fallback)}</p>`;
                return;
            }

            ui.portalOrdersList.innerHTML = visibleOrders.map((order) => {
                const nextStatus = nextPortalOrderStatus(order.status);
                const timeline = formatPortalOrderTimeline(order);
                const shipDateValue = order.confirmedShipDate || (order.shippedAt ? String(order.shippedAt).slice(0, 10) : todayIso());
                const totalOrdered = order.lines.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0);
                const totalAvailable = order.lines.reduce((sum, line) => sum + Math.min(Number(line.availableQuantity) || 0, Number(line.quantity) || 0), 0);
                const insufficientLines = order.lines.filter((line) => Number(line.availableQuantity) < Number(line.quantity));
                const allAllocated = insufficientLines.length === 0 && order.lines.length > 0;
                const detailedLines = order.lines.length
                    ? `
                        <div class="portal-order-line-table-wrap">
                            <table class="data-table compact-table">
                                <thead>
                                    <tr>
                                        <th>SKU</th>
                                        <th>Description</th>
                                        <th>Ordered</th>
                                        <th>Available</th>
                                        <th>Allocation</th>
                                        <th>Pick Locations</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${order.lines.map((line) => {
                                        const ordered = Number(line.quantity) || 0;
                                        const available = Number(line.availableQuantity) || 0;
                                        const allocated = Math.min(ordered, available);
                                        const insufficient = available < ordered;
                                        return `
                                            <tr class="${insufficient ? "insufficient-line" : ""}">
                                                <td>${esc(line.sku)}</td>
                                                <td>${esc(line.description || "")}</td>
                                                <td>${esc(formatTrackedQuantity(ordered, line.trackingLevel))}</td>
                                                <td>${esc(formatTrackedQuantity(available, line.trackingLevel))}</td>
                                                <td><span class="pill ${insufficient ? "warning" : "success"}">${insufficient ? `Short ${esc(formatTrackedQuantity(ordered - available, line.trackingLevel))}` : `Allocated ${esc(formatTrackedQuantity(allocated, line.trackingLevel))}`}</span></td>
                                                <td>${line.pickLocations?.length ? line.pickLocations.map((entry) => `${esc(entry.location)} (${esc(formatTrackedQuantity(entry.quantity, entry.trackingLevel || line.trackingLevel))})`).join("<br>") : "No location found"}</td>
                                            </tr>
                                        `;
                                    }).join("")}
                                </tbody>
                            </table>
                        </div>
                    `
                    : "";
                return `
                    <div class="quick-row">
                        <div class="quick-detail-stack">
                            <div class="quick-main">
                                <strong>${esc(order.orderCode)} | ${esc(order.accountName)}</strong>
                                <div class="quick-meta">${esc(order.status)} | PO ${esc(order.poNumber || "None")} | ${esc(order.shippingReference || "No shipping ref")} | ${esc(formatDate(order.createdAt))}</div>
                                <div class="quick-meta">Requested Ship Date: ${esc(order.requestedShipDate || "Not set")}${order.shipToName ? ` | Ship To ${esc(order.shipToName)}` : ""}</div>
                                <div class="quick-meta">${esc(order.shipToName || order.contactName || "No contact")} ${(order.shipToPhone || order.contactPhone) ? `| ${esc(order.shipToPhone || order.contactPhone)}` : ""}</div>
                                <div class="quick-meta">${esc(order.shipToAddress1 || "")}${order.shipToCity ? ` | ${esc([order.shipToCity, order.shipToState, order.shipToPostalCode].filter(Boolean).join(", "))}` : ""}</div>
                                <div class="order-health-grid">
                                    <div class="order-health-card">
                                        <span>Ordered Qty</span>
                                        <strong>${esc(formatTrackedQuantity(totalOrdered, order.lines[0]?.trackingLevel || "UNIT"))}</strong>
                                    </div>
                                    <div class="order-health-card ${insufficientLines.length ? "danger" : ""}">
                                        <span>Allocatable Qty</span>
                                        <strong>${esc(formatTrackedQuantity(totalAvailable, order.lines[0]?.trackingLevel || "UNIT"))}</strong>
                                    </div>
                                    <div class="order-health-card">
                                        <span>Auto Allocation</span>
                                        <strong>${allAllocated ? "Ready to pick" : `${insufficientLines.length} line${insufficientLines.length === 1 ? "" : "s"} short`}</strong>
                                    </div>
                                </div>
                                ${order.orderNotes ? `<div class="quick-meta">Order Notes: ${esc(order.orderNotes)}</div>` : ""}
                                ${detailedLines}
                                ${order.status === "SHIPPED" || order.confirmedShipDate || order.shippedCarrierName || order.shippedTrackingReference || order.shippedConfirmationNote ? `
                                    <div class="quick-meta">
                                        ${esc([
                                            order.confirmedShipDate ? `Shipped Date ${order.confirmedShipDate}` : "",
                                            order.shippedCarrierName ? `Carrier ${order.shippedCarrierName}` : "",
                                            order.shippedTrackingReference ? `Tracking ${order.shippedTrackingReference}` : ""
                                        ].filter(Boolean).join(" | ") || "Shipping confirmation saved")}
                                    </div>
                                ` : ""}
                                ${order.shippedConfirmationNote ? `<div class="quick-meta">Warehouse Note: ${esc(order.shippedConfirmationNote)}</div>` : ""}
                                ${timeline ? `<div class="quick-meta">${esc(timeline)}</div>` : ""}
                            </div>
                            <div class="quick-row-actions">
                                <span class="pill ${portalOrderStatusTone(order.status)}">${esc(order.status)}</span>
                                ${insufficientLines.length ? `<span class="pill warning">Insufficient stock</span>` : `<span class="pill success">Allocation ready</span>`}
                                <button class="btn ghost mini" type="button" data-print-pick-ticket="${attr(order.id)}">Print Pick Ticket</button>
                                <button class="btn ghost mini" type="button" data-print-packing-slip="${attr(order.id)}">Print Packing Slip</button>
                                ${nextStatus && nextStatus !== "SHIPPED" ? `<button class="btn ghost mini" type="button" data-portal-order-status="${attr(order.id)}" data-next-status="${attr(nextStatus)}">${esc(portalOrderActionLabel(nextStatus))}</button>` : ""}
                            </div>
                            ${(order.status === "STAGED" || order.status === "SHIPPED") ? `
                                <div class="portal-order-shipping-box">
                                    <div class="form-grid compact-grid">
                                        <label class="field">
                                            <span>Ship Date</span>
                                            <input data-portal-ship-date="${attr(order.id)}" type="date" value="${attr(shipDateValue)}">
                                        </label>
                                        <label class="field">
                                            <span>Carrier</span>
                                            <input data-portal-ship-carrier="${attr(order.id)}" type="text" placeholder="UPS, LTL carrier, courier" value="${attr(order.shippedCarrierName || "")}">
                                        </label>
                                        <label class="field">
                                            <span>Tracking / PRO / BOL</span>
                                            <input data-portal-ship-tracking="${attr(order.id)}" type="text" placeholder="Tracking, PRO, or BOL #" value="${attr(order.shippedTrackingReference || "")}">
                                        </label>
                                        <label class="field span-2">
                                            <span>Shipping Note</span>
                                            <input data-portal-ship-note="${attr(order.id)}" type="text" placeholder="Optional shipped confirmation note" value="${attr(order.shippedConfirmationNote || "")}">
                                        </label>
                                        <label class="field span-2">
                                            <span>Shipped Documents</span>
                                            <input data-portal-ship-documents="${attr(order.id)}" type="file" accept="application/pdf,image/*" multiple>
                                        </label>
                                    </div>
                                    <div class="quick-meta">${insufficientLines.length ? "Shipping stays blocked until every line has enough available stock." : "Upload POD, signed BOL, packing slip, or carrier confirmation. Images are compressed before upload."}</div>
                                    ${order.documents.length ? `
                                        <div class="portal-order-doc-list">
                                            ${order.documents.map((document) => `
                                                <a class="portal-order-doc-link" href="${attr(document.downloadUrl)}" target="_blank" rel="noopener">
                                                    ${esc(document.fileName)}${document.fileSize ? ` (${esc(formatDocumentFileSize(document.fileSize))})` : ""}
                                                </a>
                                            `).join("")}
                                        </div>
                                    ` : `<div class="quick-meta">No shipped documents saved yet.</div>`}
                                    <div class="quick-row-actions">
                                        <button class="btn ${order.status === "STAGED" ? "" : "secondary"}" type="button" data-portal-ship-confirmation="${attr(order.id)}" data-portal-transition="${attr(order.status === "STAGED" ? "SHIPPED" : "SAVE")}" ${insufficientLines.length ? "disabled" : ""}>${order.status === "STAGED" ? "Mark Shipped" : "Save Shipping Confirmation"}</button>
                                    </div>
                                </div>
                            ` : ""}
                        </div>
                    </div>
                `;
            }).join("");
        }

        function nextPortalOrderStatus(status) {
            if (status === "RELEASED") return "PICKED";
            if (status === "PICKED") return "STAGED";
            if (status === "STAGED") return "SHIPPED";
            return "";
        }

        function portalOrderActionLabel(status) {
            if (status === "PICKED") return "Mark Picked";
            if (status === "STAGED") return "Mark Staged";
            if (status === "SHIPPED") return "Mark Shipped";
            return status;
        }

        function portalOrderStatusTone(status) {
            return status === "DRAFT" ? "warn" : "success";
        }

        function formatPortalOrderTimeline(order) {
            if (order.shippedAt) return `Shipped ${formatDate(order.shippedAt)}`;
            if (order.stagedAt) return `Staged ${formatDate(order.stagedAt)}`;
            if (order.pickedAt) return `Picked ${formatDate(order.pickedAt)}`;
            if (order.releasedAt) return `Released ${formatDate(order.releasedAt)}`;
            return "";
        }

        function formatDocumentFileSize(bytes) {
            const size = Number(bytes) || 0;
            if (size <= 0) return "0 B";
            if (size < 1024) return `${size} B`;
            if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
            return `${(size / (1024 * 1024)).toFixed(1)} MB`;
        }

        function todayIso() {
            return new Date().toISOString().slice(0, 10);
        }

        function getPortalOrderById(orderId) {
            return portalOrderRecords.find((entry) => String(entry.id) === String(orderId)) || null;
        }

        function formatPortalOrderShipTo(order) {
            return [
                order.shipToName || order.contactName || "",
                order.shipToPhone ? `Phone: ${order.shipToPhone}` : (order.contactPhone ? `Phone: ${order.contactPhone}` : ""),
                order.shipToAddress1,
                order.shipToAddress2,
                [order.shipToCity, order.shipToState, order.shipToPostalCode].filter(Boolean).join(", "),
                order.shipToCountry || ""
            ]
                .filter(Boolean)
                .join("<br>");
        }

        function buildPickTicketHtml(order) {
            const lineRows = order.lines.map((line) => `
                <tr>
                    <td>${esc(line.sku)}</td>
                    <td>${esc(line.description || "")}</td>
                    <td>${esc(formatTrackedQuantity(line.quantity, line.trackingLevel))}</td>
                    <td>${line.pickLocations?.length
                        ? line.pickLocations.map((entry) => `${esc(entry.location)} (${esc(formatTrackedQuantity(entry.quantity, entry.trackingLevel || line.trackingLevel))})`).join("<br>")
                        : "No location found"}</td>
                </tr>
            `).join("");
            return `<!doctype html><html><head><meta charset="utf-8"><title>Pick Ticket ${esc(order.orderCode)}</title><style>
                body{font-family:Arial,sans-serif;padding:24px;color:#111} h1{margin:0 0 8px} .meta{margin:0 0 16px;font-size:14px} table{width:100%;border-collapse:collapse;margin-top:16px} th,td{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top} th{background:#f3f6fb} .two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}.box{border:1px solid #ccc;padding:12px;border-radius:8px;min-height:72px}
            </style></head><body>
                <h1>Pick Ticket</h1>
                <div class="meta"><strong>Order:</strong> ${esc(order.orderCode)} | <strong>Company:</strong> ${esc(order.accountName)} | <strong>Status:</strong> ${esc(order.status)}</div>
                <div class="meta"><strong>PO:</strong> ${esc(order.poNumber || "") } | <strong>Requested Ship Date:</strong> ${esc(order.requestedShipDate || "")}</div>
                <div class="two-col">
                    <div class="box"><strong>Ship To</strong><br>${formatPortalOrderShipTo(order)}</div>
                    <div class="box"><strong>Order Notes</strong><br>${esc(order.orderNotes || "") || "None"}</div>
                </div>
                <table><thead><tr><th>SKU</th><th>Description</th><th>Qty</th><th>Pick Locations</th></tr></thead><tbody>${lineRows}</tbody></table>
            </body></html>`;
        }

        function buildPackingSlipHtml(order) {
            const shipFrom = [order.accountName || "", "c/o Grey Wolf 3PL & Logistics Inc.", "1330 Courtney Park Dr E, Dock 18", "Mississauga, ON L5T 1K5", "Canada"].filter(Boolean).join("<br>");
            const lineRows = order.lines.map((line) => `
                <tr>
                    <td>${esc(line.sku)}</td>
                    <td>${esc(line.description || "")}</td>
                    <td>${esc(formatTrackedQuantity(line.quantity, line.trackingLevel))}</td>
                </tr>
            `).join("");
            return `<!doctype html><html><head><meta charset="utf-8"><title>Packing Slip ${esc(order.orderCode)}</title><style>
                body{font-family:Arial,sans-serif;padding:24px;color:#111} h1{margin:0 0 8px} .meta{margin:0 0 16px;font-size:14px} table{width:100%;border-collapse:collapse;margin-top:16px} th,td{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top} th{background:#f3f6fb} .two-col{display:grid;grid-template-columns:1fr 1fr;gap:18px}.box{border:1px solid #ccc;padding:12px;border-radius:8px;min-height:92px}
            </style></head><body>
                <h1>Packing Slip</h1>
                <div class="meta"><strong>Order:</strong> ${esc(order.orderCode)} | <strong>Company:</strong> ${esc(order.accountName)} | <strong>Ship Ref:</strong> ${esc(order.shippingReference || "")}</div>
                <div class="meta"><strong>PO:</strong> ${esc(order.poNumber || "") } | <strong>Requested Ship Date:</strong> ${esc(order.requestedShipDate || "")}</div>
                <div class="two-col">
                    <div class="box"><strong>Ship From</strong><br>${shipFrom}</div>
                    <div class="box"><strong>Ship To</strong><br>${formatPortalOrderShipTo(order)}</div>
                </div>
                <table><thead><tr><th>SKU</th><th>Description</th><th>Qty</th></tr></thead><tbody>${lineRows}</tbody></table>
            </body></html>`;
        }

        function printPortalOrderDocument(order, type) {
            const html = type === "pick" ? buildPickTicketHtml(order) : buildPackingSlipHtml(order);
            const printWindow = window.open("", "_blank", "width=900,height=700");
            if (!printWindow) {
                showMessage(ui.portalOrdersMessage, "Allow pop-ups to print documents.", "error");
                return;
            }
            try {
                printWindow.document.open();
                printWindow.document.write(html);
                printWindow.document.close();
                const triggerPrint = () => {
                    try {
                        printWindow.focus();
                        printWindow.print();
                    } catch (error) {
                        console.error("Print failed", error);
                    }
                };
                if (printWindow.document.readyState === "complete") {
                    setTimeout(triggerPrint, 150);
                } else {
                    printWindow.addEventListener("load", () => setTimeout(triggerPrint, 150), { once: true });
                    setTimeout(triggerPrint, 600);
                }
                showMessage(ui.portalOrdersMessage, type === "pick" ? "Pick ticket opened for printing." : "Packing slip opened for printing.", "success");
            } catch (error) {
                console.error("Document print window error", error);
                showMessage(ui.portalOrdersMessage, "Unable to open the print view.", "error");
            }
        }

        async function onPortalOrdersListClick(event) {
            const pickTicketButton = event.target.closest("[data-print-pick-ticket]");
            if (pickTicketButton) {
                const order = getPortalOrderById(pickTicketButton.dataset.printPickTicket || "");
                if (order) printPortalOrderDocument(order, "pick");
                return;
            }

            const packingSlipButton = event.target.closest("[data-print-packing-slip]");
            if (packingSlipButton) {
                const order = getPortalOrderById(packingSlipButton.dataset.printPackingSlip || "");
                if (order) printPortalOrderDocument(order, "packing");
                return;
            }

            const shipButton = event.target.closest("[data-portal-ship-confirmation]");
            if (shipButton) {
                const orderId = shipButton.dataset.portalShipConfirmation || "";
                if (!orderId) return;
                try {
                    shipButton.disabled = true;
                    const orderCard = shipButton.closest(".quick-detail-stack") || shipButton.closest(".quick-row");
                    const shipDate = orderCard?.querySelector(`[data-portal-ship-date="${orderId}"]`)?.value || "";
                    const carrierName = orderCard?.querySelector(`[data-portal-ship-carrier="${orderId}"]`)?.value || "";
                    const trackingNumber = orderCard?.querySelector(`[data-portal-ship-tracking="${orderId}"]`)?.value || "";
                    const shippingNote = orderCard?.querySelector(`[data-portal-ship-note="${orderId}"]`)?.value || "";
                    const fileInput = orderCard?.querySelector(`[data-portal-ship-documents="${orderId}"]`);
                    const documents = await readPortalShippingDocuments(fileInput?.files);
                    await requestJson(`/api/admin/portal-orders/${orderId}/status`, {
                        method: "POST",
                        body: JSON.stringify({
                            status: "SHIPPED",
                            confirmedShipDate: shipDate,
                            shippedCarrierName: carrierName,
                            shippedTrackingReference: trackingNumber,
                            shippedConfirmationNote: shippingNote,
                            documents
                        })
                    });
                    await syncServerState(true);
                    await refreshPortalOrdersList(true);
                    showMessage(ui.portalOrdersMessage, "Shipping confirmation saved.", "success");
                } catch (error) {
                    showMessage(ui.portalOrdersMessage, error.message, "error");
                } finally {
                    shipButton.disabled = false;
                }
                return;
            }

            const button = event.target.closest("[data-portal-order-status]");
            if (!button) return;

            const orderId = button.dataset.portalOrderStatus || "";
            const nextStatus = norm(button.dataset.nextStatus || "");
            if (!orderId || !nextStatus) return;
            const label = portalOrderActionLabel(nextStatus);

            try {
                await requestJson(`/api/admin/portal-orders/${orderId}/status`, {
                    method: "POST",
                    body: JSON.stringify({ status: nextStatus })
                });
                await syncServerState(true);
                await refreshPortalOrdersList(true);
                showMessage(ui.portalOrdersMessage, `${label} complete.`, "success");
            } catch (error) {
                showMessage(ui.portalOrdersMessage, error.message, "error");
            }
        }

        async function saveMasterLocation(event) {
            event.preventDefault();
            const code = norm(ui.masterLocationCode.value);
            const note = String(ui.masterLocationNote.value || "").trim().replace(/\s+/g, " ");
            if (!code) return fail(ui.catalogMessage, "Enter a BIN or location code to save.", ui.masterLocationCode);

            try {
                await requestJson("/api/master-location", {
                    method: "POST",
                    body: JSON.stringify({ code, note })
                });
                await syncServerState(true);
                showMessage(ui.catalogMessage, `Saved BIN ${code} to the shared library.`, "success");
                document.getElementById("masterLocationForm").reset();
                ui.masterLocationCode.focus();
            } catch (error) {
                showMessage(ui.catalogMessage, error.message, "error");
            }
        }

        async function saveMasterItem(event) {
            event.preventDefault();
            const accountName = getScopedCompanyValue(ui.masterItemAccount.value);
            const sku = norm(ui.masterItemSku.value);
            const upc = norm(ui.masterItemUpc.value);
            const description = String(ui.masterItemDescription.value || "").trim().replace(/\s+/g, " ");
            const imageUrl = normalizeImageReference(ui.masterItemImageUrl.value);
            const trackingLevel = normalizeTrackingLevel(ui.masterItemTrackingLevel.value);
            const unitsPerCase = toPositiveInt(ui.masterItemUnitsPerCase.value);
            const eachLength = toPositiveNumber(ui.masterItemEachLength.value);
            const eachWidth = toPositiveNumber(ui.masterItemEachWidth.value);
            const eachHeight = toPositiveNumber(ui.masterItemEachHeight.value);
            const caseLength = toPositiveNumber(ui.masterItemCaseLength.value);
            const caseWidth = toPositiveNumber(ui.masterItemCaseWidth.value);
            const caseHeight = toPositiveNumber(ui.masterItemCaseHeight.value);
            if (!accountName) return fail(ui.catalogMessage, "Enter the company before saving an item master.", ui.masterItemAccount);
            if (!sku) return fail(ui.catalogMessage, "Enter a SKU to save an item master.", ui.masterItemSku);

            try {
                const payload = {
                    accountName,
                    sku,
                    upc,
                    description,
                    imageUrl,
                    trackingLevel,
                    unitsPerCase,
                    eachLength,
                    eachWidth,
                    eachHeight,
                    caseLength,
                    caseWidth,
                    caseHeight
                };
                if (editingMasterItem && editingMasterItem.accountName === accountName && editingMasterItem.sku !== sku) {
                    const existingTarget = state.masters.items.find((item) => item.accountName === accountName && item.sku === sku && item.id !== editingMasterItem.id);
                    if (existingTarget && !window.confirm(`An item already exists for ${accountName} / ${sku}. Updating this saved item will merge matching inventory lines into that SKU. Continue?`)) {
                        return;
                    }
                }

                await requestJson(editingMasterItem ? "/api/master-item/update" : "/api/master-item", {
                    method: "POST",
                    body: JSON.stringify(editingMasterItem ? {
                        ...payload,
                        originalAccountName: editingMasterItem.accountName,
                        originalSku: editingMasterItem.sku
                    } : payload)
                });
                await syncServerState(true);
                setActiveCompany(accountName, { force: true, rerender: false });
                showMessage(ui.catalogMessage, `${editingMasterItem ? "Updated" : "Saved"} item ${accountName} / ${sku} in the shared library.`, "success");
                resetMasterItemForm(accountName);
                ui.masterItemSku.focus();
            } catch (error) {
                showMessage(ui.catalogMessage, error.message, "error");
            }
        }

        function resetMasterItemForm(accountName = "") {
            editingMasterItem = null;
            document.getElementById("masterItemForm").reset();
            ui.masterItemAccount.disabled = false;
            ui.masterItemSubmitBtn.textContent = "Save Item";
            ui.cancelMasterItemEditBtn.classList.add("hidden");
            ui.masterItemEditorBanner.classList.add("hidden");
            ui.masterItemAccount.value = accountName || "";
            ui.masterItemTrackingLevel.value = "UNIT";
            clearImageField({
                urlInput: ui.masterItemImageUrl,
                previewWrap: ui.masterItemImagePreviewWrap,
                previewImg: ui.masterItemImagePreview,
                previewMeta: ui.masterItemImagePreviewMeta,
                clearBtn: ui.masterItemImageClearBtn,
                defaultMeta: "Compressed item photo preview"
            });
        }

        function beginMasterItemEdit(item) {
            if (!item) return;
            setActiveCompany(item.accountName, { force: true, rerender: false });
            editingMasterItem = { id: item.id, accountName: item.accountName, sku: item.sku };
            ui.masterItemAccount.value = item.accountName;
            ui.masterItemAccount.disabled = true;
            ui.masterItemSku.value = item.sku;
            ui.masterItemUpc.value = item.upc || "";
            ui.masterItemDescription.value = item.description || "";
            ui.masterItemImageUrl.value = item.imageUrl || "";
            ui.masterItemTrackingLevel.value = normalizeTrackingLevel(item.trackingLevel);
            ui.masterItemUnitsPerCase.value = item.unitsPerCase ?? "";
            ui.masterItemEachLength.value = item.eachLength ?? "";
            ui.masterItemEachWidth.value = item.eachWidth ?? "";
            ui.masterItemEachHeight.value = item.eachHeight ?? "";
            ui.masterItemCaseLength.value = item.caseLength ?? "";
            ui.masterItemCaseWidth.value = item.caseWidth ?? "";
            ui.masterItemCaseHeight.value = item.caseHeight ?? "";
            ui.masterItemSubmitBtn.textContent = "Update Item";
            ui.cancelMasterItemEditBtn.classList.remove("hidden");
            ui.masterItemEditorBanner.classList.remove("hidden");
            ui.masterItemEditorTitle.textContent = `Editing ${item.accountName} / ${item.sku}`;
            ui.masterItemEditorMeta.textContent = "SKU changes update matching inventory lines for this company. Company stays locked during edit.";
            refreshImagePreview({
                urlInput: ui.masterItemImageUrl,
                previewWrap: ui.masterItemImagePreviewWrap,
                previewImg: ui.masterItemImagePreview,
                previewMeta: ui.masterItemImagePreviewMeta,
                clearBtn: ui.masterItemImageClearBtn,
                defaultMeta: "Compressed item photo preview"
            });
            ui.masterItemSku.focus();
        }

        function cancelMasterItemEdit() {
            resetMasterItemForm(getActiveCompany() || state.preferences.lastAccount || "");
            ui.masterItemAccount.focus();
            showMessage(ui.catalogMessage, "Item edit canceled.", "info");
        }

        function renderMasterLibrary() {
            const query = norm(ui.masterFilter.value);
            const companyFilter = getActiveCompany();
            const ownerMatches = [...state.masters.ownerRecords]
                .filter((entry) => (!companyFilter || entry.name === companyFilter) && (!query || entry.name.includes(query) || norm(entry.note).includes(query)))
                .sort((a, b) => a.name.localeCompare(b.name));
            const locationMatches = [...state.masters.locations]
                .filter((entry) => !query || entry.code.includes(query) || norm(entry.note).includes(query))
                .sort((a, b) => a.code.localeCompare(b.code));
            const itemMatches = [...state.masters.items]
                .filter((item) => (!companyFilter || item.accountName === companyFilter) && (!query
                    || item.accountName.includes(query)
                    || item.sku.includes(query)
                    || item.upc.includes(query)
                    || norm(item.description).includes(query)))
                .sort((a, b) => a.accountName.localeCompare(b.accountName) || a.sku.localeCompare(b.sku));

            const visibleOwners = ownerMatches.slice(0, query ? 24 : 12);
            const visibleLocations = locationMatches.slice(0, query ? 24 : 12);
            const visibleItems = itemMatches.slice(0, query ? 24 : 12);

            ui.masterOwnerCount.textContent = query
                ? `${num(ownerMatches.length)} shown / ${num(state.masters.ownerRecords.length)} saved`
                : `${num(state.masters.ownerRecords.length)} saved`;
            ui.masterLocationCount.textContent = query
                ? `${num(locationMatches.length)} shown / ${num(state.masters.locations.length)} saved`
                : `${num(state.masters.locations.length)} saved`;
            ui.masterItemCount.textContent = query
                ? `${num(itemMatches.length)} shown / ${num(state.masters.items.length)} saved`
                : `${num(state.masters.items.length)} saved`;

            ui.masterOwnerList.innerHTML = renderMasterOwnerRows(visibleOwners, ownerMatches.length, query);
            ui.masterLocationList.innerHTML = renderMasterLocationRows(visibleLocations, locationMatches.length, query);
            ui.masterItemList.innerHTML = renderMasterItemRows(visibleItems, itemMatches.length, query);
        }

        function renderMasterOwnerRows(owners, totalMatches, query) {
            if (!owners.length) {
                return `<p class="empty">${query ? `No saved companies matched "${esc(query)}".` : "No companies saved yet. Add them here so they show up in autocomplete."}</p>`;
            }

            const rows = owners.map((entry) => {
                const meta = [
                    entry.contactName ? `Contact ${entry.contactName}` : "",
                    entry.email ? `Email ${entry.email}` : "",
                    entry.portalLoginEmail ? `Portal ${entry.portalLoginEmail}` : "",
                    entry.phone ? `Phone ${entry.phone}` : "",
                    entry.city ? [entry.city, entry.state, entry.country].filter(Boolean).join(", ") : "",
                    entry.isActive === false ? "Inactive" : "Active"
                ].filter(Boolean).join(" | ");
                return `
                <div class="quick-row">
                    <div class="quick-main">
                        <strong>${esc(entry.name)}</strong>
                        <div class="quick-meta">${esc(meta || entry.note || "Saved company")}</div>
                        ${entry.note ? `<div class="quick-meta">${esc(entry.note)}</div>` : ""}
                    </div>
                    <button class="btn ghost mini" type="button" data-use-owner="${attr(entry.name)}">Use</button>
                </div>
            `;}).join("");

            if (owners.length < totalMatches) {
                return `${rows}<p class="meta">Showing the first ${num(owners.length)} of ${num(totalMatches)} companies. Narrow the filter to see more.</p>`;
            }

            return rows;
        }

        function renderMasterLocationRows(locations, totalMatches, query) {
            if (!locations.length) {
                return `<p class="empty">${query ? `No saved BINs matched "${esc(query)}".` : "No BINs saved yet. Add your most-used locations here for faster lookup."}</p>`;
            }

            const rows = locations.map((entry) => `
                <div class="quick-row">
                    <div class="quick-main">
                        <strong>${esc(entry.code)}</strong>
                        <div class="quick-meta">${esc(entry.note || "Saved BIN location")}</div>
                    </div>
                    <button class="btn ghost mini" type="button" data-use-location="${attr(entry.code)}">Use In Scan</button>
                </div>
            `).join("");

            if (locations.length < totalMatches) {
                return `${rows}<p class="meta">Showing the first ${num(locations.length)} of ${num(totalMatches)} BINs. Narrow the filter to see more.</p>`;
            }

            return rows;
        }

        function renderMasterItemRows(items, totalMatches, query) {
            if (!items.length) {
                return `<p class="empty">${query ? `No saved items matched "${esc(query)}".` : "No items saved yet. Add common SKUs here to speed up repeat work."}</p>`;
            }

            const rows = items.map((item) => {
                const meta = formatItemMasterMeta(item);
                return `
                    <div class="quick-row">
                        ${item.imageUrl ? `<img class="quick-media" src="${attr(normalizeImageReference(item.imageUrl))}" alt="${attr(`${item.accountName} ${item.sku}`)}">` : ""}
                        <div class="quick-main">
                            <strong>${esc(item.accountName)} / ${esc(item.sku)}</strong>
                            <div class="quick-meta">${esc(meta)}</div>
                        </div>
                        <div class="quick-row-actions">
                            <button class="btn ghost mini" type="button" data-use-item="${attr(item.id)}">Use In Scan</button>
                            <button class="btn ghost mini" type="button" data-edit-item="${attr(item.id)}">Edit</button>
                        </div>
                    </div>
                `;
            }).join("");

            if (items.length < totalMatches) {
                return `${rows}<p class="meta">Showing the first ${num(items.length)} of ${num(totalMatches)} items. Narrow the filter to see more.</p>`;
            }

            return rows;
        }

        async function exportLocationCsv() {
            try {
                await syncServerState(true);
                const rows = [["BIN", "NOTE"]].concat(
                    [...state.masters.locations]
                        .sort((a, b) => a.code.localeCompare(b.code))
                        .map((entry) => [entry.code, entry.note || ""])
                );
                downloadBlob(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `wms365-scanner-bins-${fileStamp()}.csv`, "text/csv;charset=utf-8");
                showMessage(ui.catalogMessage, "BIN library exported as CSV.", "success");
            } catch (error) {
                showMessage(ui.catalogMessage, error.message, "error");
            }
        }

        async function exportItemCsv() {
            try {
                await syncServerState(true);
                const rows = [[
                    "VENDOR_CUSTOMER",
                    "SKU",
                    "UPC",
                    "DESCRIPTION",
                    "IMAGE_URL",
                    "TRACKING",
                    "UNITS_PER_CASE",
                    "EACH_LENGTH",
                    "EACH_WIDTH",
                    "EACH_HEIGHT",
                    "CASE_LENGTH",
                    "CASE_WIDTH",
                    "CASE_HEIGHT"
                ]].concat(
                    [...state.masters.items]
                        .sort((a, b) => {
                            const accountSort = a.accountName.localeCompare(b.accountName);
                            return accountSort || a.sku.localeCompare(b.sku);
                        })
                        .map((entry) => [
                            entry.accountName,
                            entry.sku,
                            entry.upc || "",
                            entry.description || "",
                            entry.imageUrl || "",
                            normalizeTrackingLevel(entry.trackingLevel),
                            entry.unitsPerCase ?? "",
                            entry.eachLength ?? "",
                            entry.eachWidth ?? "",
                            entry.eachHeight ?? "",
                            entry.caseLength ?? "",
                            entry.caseWidth ?? "",
                            entry.caseHeight ?? ""
                        ])
                );
                downloadBlob(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `wms365-scanner-items-${fileStamp()}.csv`, "text/csv;charset=utf-8");
                showMessage(ui.catalogMessage, "Item master library exported as CSV.", "success");
            } catch (error) {
                showMessage(ui.catalogMessage, error.message, "error");
            }
        }

        function importLocationCsv(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const rows = parseCsv(String(reader.result || ""));
                    const locations = mapLocationCsvRows(rows);
                    if (!locations.length) {
                        throw new Error("No BIN rows were found. Use columns like BIN and NOTE.");
                    }

                    await requestJson("/api/master-locations/import", {
                        method: "POST",
                        body: JSON.stringify({ locations })
                    });

                    await syncServerState(true);
                    showMessage(ui.catalogMessage, `Imported ${num(locations.length)} BIN location${locations.length === 1 ? "" : "s"} from CSV.`, "success");
                } catch (error) {
                    showMessage(ui.catalogMessage, `BIN import failed: ${error.message}`, "error");
                } finally {
                    ui.importLocationCsvInput.value = "";
                }
            };
            reader.onerror = () => {
                showMessage(ui.catalogMessage, "Unable to read the selected CSV file.", "error");
                ui.importLocationCsvInput.value = "";
            };
            reader.readAsText(file);
        }

        function importItemCsv(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const rows = parseCsv(String(reader.result || ""));
                    const items = mapItemCsvRows(rows);
                    if (!items.length) {
                        throw new Error("No item rows were found. Use columns like VENDOR_CUSTOMER and SKU.");
                    }

                    await requestJson("/api/master-items/import", {
                        method: "POST",
                        body: JSON.stringify({ items })
                    });

                    await syncServerState(true);
                    showMessage(ui.catalogMessage, `Imported ${num(items.length)} item master${items.length === 1 ? "" : "s"} from CSV.`, "success");
                } catch (error) {
                    showMessage(ui.catalogMessage, `Item import failed: ${error.message}`, "error");
                } finally {
                    ui.importItemCsvInput.value = "";
                }
            };
            reader.onerror = () => {
                showMessage(ui.catalogMessage, "Unable to read the selected CSV file.", "error");
                ui.importItemCsvInput.value = "";
            };
            reader.readAsText(file);
        }

        function onMasterLocationListClick(event) {
            const button = event.target.closest("[data-use-location]");
            if (!button) return;
            fillScanFromMasterLocation(button.dataset.useLocation);
        }

        function onMasterOwnerListClick(event) {
            const button = event.target.closest("[data-use-owner]");
            if (!button) return;
            fillScanFromOwner(button.dataset.useOwner);
        }

        function onMasterItemListClick(event) {
            const editButton = event.target.closest("[data-edit-item]");
            if (editButton) {
                const item = state.masters.items.find((entry) => entry.id === editButton.dataset.editItem);
                beginMasterItemEdit(item);
                return;
            }
            const button = event.target.closest("[data-use-item]");
            if (!button) return;
            fillScanFromMasterItem(button.dataset.useItem);
        }

        function fillScanFromOwner(name) {
            const normalized = norm(name);
            if (!normalized) return;
            setActiveCompany(normalized, { force: true, rerender: false });
            ui.scanAccount.value = normalized;
            ui.masterItemAccount.value = normalized;
            if ((ui.scanLocation.value || "").trim()) ui.scanSku.focus();
            else ui.scanLocation.focus();
            showMessage(ui.catalogMessage, `Loaded company ${normalized} into the scan form.`, "info");
        }

        function fillScanFromMasterLocation(code) {
            const normalized = norm(code);
            if (!normalized) return;
            ui.scanLocation.value = normalized;
            state.preferences.lastLocation = normalized;
            saveState();
            if (norm(ui.scanAccount.value)) ui.scanSku.focus();
            else ui.scanAccount.focus();
            showMessage(ui.catalogMessage, `Loaded BIN ${normalized} into the scan form.`, "info");
        }

        function fillScanFromMasterItem(code, options = {}) {
            const silent = !!options.silent;
            const item = state.masters.items.find((entry) => entry.id === code) || findMasterItemByCode(code, ui.scanAccount.value);
            if (!item) return;
            setActiveCompany(item.accountName, { force: true, rerender: false });
            ui.scanAccount.value = item.accountName;
            syncScanItemSelectors();
            ui.scanSku.value = item.sku;
            ui.scanUpc.value = item.upc || ui.scanUpc.value;
            ui.scanDescription.value = item.description || "";
            ui.scanImageUrl.value = item.imageUrl || "";
            ui.scanTrackingLevel.value = normalizeTrackingLevel(item.trackingLevel);
            updateScanTrackingUi(item);
            refreshImagePreview({
                urlInput: ui.scanImageUrl,
                previewWrap: ui.scanImagePreviewWrap,
                previewImg: ui.scanImagePreview,
                previewMeta: ui.scanImagePreviewMeta,
                clearBtn: ui.scanImageClearBtn,
                defaultMeta: "Compressed photo preview"
            });
            ui.scanQuantity.focus();
            if (!silent) {
                showMessage(ui.catalogMessage, `Loaded item ${item.accountName} / ${item.sku} into the scan form.`, "info");
            }
        }

        function syncScanFieldsFromCatalog() {
            syncScanItemSelectors();
            const accountName = getScopedCompanyValue(ui.scanAccount.value);
            const sku = norm(ui.scanSku.value);
            const upc = norm(ui.scanUpc.value);

            if (!accountName) {
                updateScanTrackingUi();
                return null;
            }

            if (upc) {
                const upcMatches = findMasterItemsByCode(upc, accountName);
                const upcMatch = upcMatches.length === 1 ? upcMatches[0] : null;
                if (upcMatch) {
                    if (!accountName) ui.scanAccount.value = upcMatch.accountName;
                    ui.scanSku.value = upcMatch.sku;
                    ui.scanUpc.value = upcMatch.upc;
                    ui.scanDescription.value = upcMatch.description || "";
                    ui.scanImageUrl.value = upcMatch.imageUrl || "";
                    ui.scanTrackingLevel.value = normalizeTrackingLevel(upcMatch.trackingLevel);
                    updateScanTrackingUi(upcMatch);
                    refreshImagePreview({
                        urlInput: ui.scanImageUrl,
                        previewWrap: ui.scanImagePreviewWrap,
                        previewImg: ui.scanImagePreview,
                        previewMeta: ui.scanImagePreviewMeta,
                        clearBtn: ui.scanImageClearBtn,
                        defaultMeta: "Compressed photo preview"
                    });
                    return upcMatch;
                }
            }

            if (sku) {
                const skuMatches = findMasterItemsByCode(sku, accountName);
                const skuMatch = skuMatches.length === 1 ? skuMatches[0] : null;
                if (skuMatch) {
                    if (!accountName) ui.scanAccount.value = skuMatch.accountName;
                    ui.scanSku.value = skuMatch.sku;
                    if (!upc && skuMatch.upc) ui.scanUpc.value = skuMatch.upc;
                    ui.scanDescription.value = skuMatch.description || "";
                    ui.scanImageUrl.value = skuMatch.imageUrl || "";
                    ui.scanTrackingLevel.value = normalizeTrackingLevel(skuMatch.trackingLevel);
                    updateScanTrackingUi(skuMatch);
                    refreshImagePreview({
                        urlInput: ui.scanImageUrl,
                        previewWrap: ui.scanImagePreviewWrap,
                        previewImg: ui.scanImagePreview,
                        previewMeta: ui.scanImagePreviewMeta,
                        clearBtn: ui.scanImageClearBtn,
                        defaultMeta: "Compressed photo preview"
                    });
                    return skuMatch;
                }
            }

            updateScanTrackingUi();
            return null;
        }

        function findMasterItemByCode(code, accountName = "") {
            const query = norm(code);
            const owner = norm(accountName);
            const matches = findMasterItemsByCode(query, owner);
            return matches.length === 1 ? matches[0] : null;
        }

        function renderReports(filterText) {
            const ownerFilter = getScopedCompanyValue(ui.reportOwner.value);
            const ownerRows = getOwnerReportRows(filterText, ownerFilter);
            const locationRows = getLocationReportRows(filterText);
            const itemRows = getItemReportRows(filterText);
            const vendorInventoryRows = getVendorInventoryReportRows(filterText, ownerFilter);
            const overallTotals = ownerRows.reduce((totals, row) => {
                totals.UNIT += row.unitCount;
                totals.CASE += row.caseCount;
                totals.PALLET += row.totalPallets;
                return totals;
            }, { UNIT: 0, CASE: 0, PALLET: 0 });
            const totalPallets = ownerRows.reduce((sum, row) => sum + row.totalPallets, 0);
            const palletLocations = new Set();

            ownerRows.forEach((row) => {
                row.palletLocations.forEach((location) => palletLocations.add(`${row.owner}::${location}`));
            });

            ui.reportOwnersCount.textContent = num(ownerRows.length);
            ui.reportPalletLocationsCount.textContent = num(palletLocations.size);
            ui.reportUnitsCount.textContent = formatTrackedSummary(overallTotals);
            ui.reportPalletsCount.textContent = num(totalPallets);

            ui.ownerReportMeta.textContent = `${num(ownerRows.length)} row${ownerRows.length === 1 ? "" : "s"}`;
            if (!ownerRows.length) {
                ui.ownerReportEmpty.classList.remove("hidden");
                ui.ownerReportWrap.classList.add("hidden");
                ui.ownerReportBody.innerHTML = "";
            } else {
                ui.ownerReportEmpty.classList.add("hidden");
                ui.ownerReportWrap.classList.remove("hidden");
                ui.ownerReportBody.innerHTML = ownerRows.map((row) => `
                    <tr>
                        <td>${esc(row.owner)}</td>
                        <td>${num(row.locationCount)}</td>
                        <td>${num(row.palletLocationCount)}</td>
                        <td>${num(row.totalPallets)}</td>
                        <td>${esc(row.quantitySummary)}</td>
                    </tr>
                `).join("");
            }

            ui.locationReportMeta.textContent = `${num(locationRows.length)} row${locationRows.length === 1 ? "" : "s"}`;
            if (!locationRows.length) {
                ui.locationReportEmpty.classList.remove("hidden");
                ui.locationReportWrap.classList.add("hidden");
                ui.locationReportBody.innerHTML = "";
            } else {
                ui.locationReportEmpty.classList.add("hidden");
                ui.locationReportWrap.classList.remove("hidden");
                ui.locationReportBody.innerHTML = locationRows.map((row) => `
                    <tr>
                        <td>${esc(row.owner)}</td>
                        <td>${esc(row.location)}</td>
                        <td>${esc(row.note || "-")}</td>
                        <td>${num(row.lineCount)}</td>
                        <td>${num(row.palletCount)}</td>
                        <td>${num(row.skuCount)}</td>
                        <td>${esc(row.quantitySummary)}</td>
                    </tr>
                `).join("");
            }

            ui.itemReportMeta.textContent = `${num(itemRows.length)} row${itemRows.length === 1 ? "" : "s"}`;
            if (!itemRows.length) {
                ui.itemReportEmpty.classList.remove("hidden");
                ui.itemReportWrap.classList.add("hidden");
                ui.itemReportBody.innerHTML = "";
            } else {
                ui.itemReportEmpty.classList.add("hidden");
                ui.itemReportWrap.classList.remove("hidden");
                ui.itemReportBody.innerHTML = itemRows.map((row) => `
                    <tr>
                        <td>${esc(row.owner)}</td>
                        <td>${esc(row.sku)}</td>
                        <td>${esc(row.upc || "-")}</td>
                        <td>${esc(row.description || "-")}</td>
                        <td>${esc(trackingLabel(row.trackingLevel))}</td>
                        <td>${num(row.locationCount)}</td>
                        <td>${num(row.lineCount)}</td>
                        <td>${num(row.totalUnits)}</td>
                    </tr>
                `).join("");
            }

            ui.vendorInventoryReportMeta.textContent = `${num(vendorInventoryRows.length)} row${vendorInventoryRows.length === 1 ? "" : "s"}`;
            if (!vendorInventoryRows.length) {
                ui.vendorInventoryReportEmpty.classList.remove("hidden");
                ui.vendorInventoryReportWrap.classList.add("hidden");
                ui.vendorInventoryReportBody.innerHTML = "";
            } else {
                ui.vendorInventoryReportEmpty.classList.add("hidden");
                ui.vendorInventoryReportWrap.classList.remove("hidden");
                ui.vendorInventoryReportBody.innerHTML = vendorInventoryRows.map((row) => `
                    <tr>
                        <td>${esc(row.owner)}</td>
                        <td>${esc(row.location)}</td>
                        <td>${esc(row.sku)}</td>
                        <td>${esc(row.upc || "-")}</td>
                        <td class="sheet-wrap">${esc(row.description || "-")}</td>
                        <td>${esc(trackingLabel(row.trackingLevel))}</td>
                        <td>${esc(formatTrackedQuantity(row.quantity, row.trackingLevel))}</td>
                        <td>${esc(formatDate(row.updatedAt))}</td>
                    </tr>
                `).join("");
            }
        }

        async function exportOwnerReportCsv() {
            try {
                await syncServerState(true);
                const rows = [["Company", "Locations", "PalletLocations", "TotalPallets", "TotalCases", "TotalUnits"]].concat(
                    getOwnerReportRows(ui.reportFilter.value, getScopedCompanyValue(ui.reportOwner.value)).map((row) => [
                        row.owner,
                        String(row.locationCount),
                        String(row.palletLocationCount),
                        String(row.totalPallets),
                        String(row.caseCount),
                        String(row.unitCount)
                    ])
                );
                downloadBlob(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `wms365-scanner-owner-report-${fileStamp()}.csv`, "text/csv;charset=utf-8");
                showMessage(ui.reportMessage, "Company utilization report exported as CSV.", "success");
            } catch (error) {
                showMessage(ui.reportMessage, error.message, "error");
            }
        }

        async function exportLocationReportCsv() {
            try {
                await syncServerState(true);
                const rows = [["Company", "Location", "Note", "Lines", "Pallets", "UniqueSkus", "TotalCases", "TotalUnits"]].concat(
                    getLocationReportRows(ui.reportFilter.value).map((row) => [
                        row.owner,
                        row.location,
                        row.note || "",
                        String(row.lineCount),
                        String(row.palletCount),
                        String(row.skuCount),
                        String(row.caseCount),
                        String(row.unitCount)
                    ])
                );
                downloadBlob(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `wms365-scanner-location-report-${fileStamp()}.csv`, "text/csv;charset=utf-8");
                showMessage(ui.reportMessage, "Location report exported as CSV.", "success");
            } catch (error) {
                showMessage(ui.reportMessage, error.message, "error");
            }
        }

        async function exportItemReportCsv() {
            try {
                await syncServerState(true);
                const rows = [["Company", "SKU", "UPC", "Description", "Tracking", "Locations", "Lines", "TotalQty"]].concat(
                    getItemReportRows(ui.reportFilter.value).map((row) => [
                        row.owner,
                        row.sku,
                        row.upc || "",
                        row.description || "",
                        trackingLabel(row.trackingLevel),
                        String(row.locationCount),
                        String(row.lineCount),
                        String(row.totalUnits)
                    ])
                );
                downloadBlob(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `wms365-scanner-item-report-${fileStamp()}.csv`, "text/csv;charset=utf-8");
                showMessage(ui.reportMessage, "Item report exported as CSV.", "success");
            } catch (error) {
                showMessage(ui.reportMessage, error.message, "error");
            }
        }

        async function exportVendorInventoryReportCsv() {
            try {
                await syncServerState(true);
                const rows = [["Company", "Location", "SKU", "UPC", "Description", "Tracking", "Qty", "Updated"]].concat(
                    getVendorInventoryReportRows(ui.reportFilter.value, getScopedCompanyValue(ui.reportOwner.value)).map((row) => [
                        row.owner,
                        row.location,
                        row.sku,
                        row.upc || "",
                        row.description || "",
                        trackingLabel(row.trackingLevel),
                        String(row.quantity),
                        formatDate(row.updatedAt)
                    ])
                );
                downloadBlob(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), `wms365-scanner-vendor-inventory-report-${fileStamp()}.csv`, "text/csv;charset=utf-8");
                showMessage(ui.reportMessage, "Company inventory report exported as CSV.", "success");
            } catch (error) {
                showMessage(ui.reportMessage, error.message, "error");
            }
        }

        function printReports() {
            const ownerFilter = getScopedCompanyValue(ui.reportOwner.value);
            const ownerRows = getOwnerReportRows(ui.reportFilter.value, ownerFilter);
            const locationRows = getLocationReportRows(ui.reportFilter.value);
            const itemRows = getItemReportRows(ui.reportFilter.value);
            const vendorInventoryRows = getVendorInventoryReportRows(ui.reportFilter.value, ownerFilter);
            if (!ownerRows.length && !locationRows.length && !itemRows.length && !vendorInventoryRows.length) {
                showMessage(ui.reportMessage, "There is no report data to print for the current filter.", "error");
                return;
            }

            openPrintWindow(
                "WMS365 Scanner - Reports",
                `
                    <h1>WMS365 Scanner</h1>
                        <div class="build-chip">Build OPSHOME-2026-04-16-12</div>
                    <p><strong>Inventory Reports</strong></p>
                    <p>Company Filter: ${esc(ownerFilter || "ALL")}</p>
                    <p>Filter: ${esc(norm(ui.reportFilter.value) || "ALL")}</p>
                    <section>
                        <h2>Company Utilization</h2>
                        ${reportTableMarkup(
                            ["Company", "Locations", "Pallet Locations", "Total Pallets", "Units / Cases"],
                            ownerRows.map((row) => [row.owner, num(row.locationCount), num(row.palletLocationCount), num(row.totalPallets), row.quantitySummary])
                        )}
                    </section>
                    <section>
                        <h2>Location Report</h2>
                        ${reportTableMarkup(
                            ["Company", "Location", "Note", "Lines", "Pallets", "Unique SKUs", "Units / Cases"],
                            locationRows.map((row) => [row.owner, row.location, row.note || "-", num(row.lineCount), num(row.palletCount), num(row.skuCount), row.quantitySummary])
                        )}
                    </section>
                    <section>
                        <h2>Item Report</h2>
                        ${reportTableMarkup(
                            ["Company", "SKU", "UPC", "Description", "Tracking", "Locations", "Lines", "Total Qty"],
                            itemRows.map((row) => [row.owner, row.sku, row.upc || "-", row.description || "-", trackingLabel(row.trackingLevel), num(row.locationCount), num(row.lineCount), num(row.totalUnits)])
                        )}
                    </section>
                    <section>
                        <h2>Inventory By Company</h2>
                        ${reportTableMarkup(
                            ["Company", "Location", "SKU", "UPC", "Description", "Tracking", "Qty", "Updated"],
                            vendorInventoryRows.map((row) => [row.owner, row.location, row.sku, row.upc || "-", row.description || "-", trackingLabel(row.trackingLevel), formatTrackedQuantity(row.quantity, row.trackingLevel), formatDate(row.updatedAt)])
                        )}
                    </section>
                `
            );
        }

        function getVendorInventoryReportRows(filterText = "", ownerFilter = "") {
            const query = norm(filterText);
            const scopedOwnerFilter = getScopedCompanyValue(ownerFilter);

            return filterInventoryByOwner(scopedOwnerFilter)
                .filter((line) => inventoryMatchesQuery(line, query))
                .map((line) => ({
                    owner: line.accountName,
                    location: line.location,
                    sku: line.sku,
                    upc: line.upc || "",
                    description: getLineDescription(line) || "",
                    trackingLevel: normalizeTrackingLevel(line.trackingLevel),
                    quantity: Number(line.quantity) || 0,
                    updatedAt: line.updatedAt
                }))
                .sort((a, b) =>
                    a.owner.localeCompare(b.owner)
                    || a.location.localeCompare(b.location)
                    || a.sku.localeCompare(b.sku)
                    || String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
                );
        }

        function getLocationReportRows(filterText = "") {
            const query = norm(filterText);
            const ownerFilter = getScopedCompanyValue(ui.reportOwner.value);
            const locationMasterMap = new Map(state.masters.locations.map((entry) => [entry.code, entry]));
            const grouped = new Map();

            filterInventoryByOwner(ownerFilter).forEach((line) => {
                if (!inventoryMatchesQuery(line, query) && !norm(locationMasterMap.get(line.location)?.note).includes(query)) return;
                const key = `${line.accountName}::${line.location}`;
                const current = grouped.get(key) || {
                    owner: line.accountName,
                    location: line.location,
                    note: locationMasterMap.get(line.location)?.note || "",
                    lineCount: 0,
                    skuSet: new Set(),
                    palletCount: 0,
                    unitCount: 0,
                    caseCount: 0
                };
                current.lineCount += 1;
                current.skuSet.add(line.sku);
                if (normalizeTrackingLevel(line.trackingLevel) === "PALLET") current.palletCount += line.quantity;
                else if (normalizeTrackingLevel(line.trackingLevel) === "CASE") current.caseCount += line.quantity;
                else current.unitCount += line.quantity;
                grouped.set(key, current);
            });

            return [...grouped.values()]
                .map((row) => ({
                    owner: row.owner,
                    location: row.location,
                    note: row.note,
                    lineCount: row.lineCount,
                    palletCount: row.palletCount,
                    skuCount: row.skuSet.size,
                    unitCount: row.unitCount,
                    caseCount: row.caseCount,
                    quantitySummary: row.unitCount || row.caseCount ? formatTrackedSummary({ UNIT: row.unitCount, CASE: row.caseCount, PALLET: 0 }) : "-"
                }))
                .sort((a, b) => a.owner.localeCompare(b.owner) || a.location.localeCompare(b.location));
        }

        function getItemReportRows(filterText = "") {
            const query = norm(filterText);
            const ownerFilter = getScopedCompanyValue(ui.reportOwner.value);
            const itemMasterMap = new Map(state.masters.items.map((item) => [`${item.accountName}::${item.sku}`, item]));
            const grouped = new Map();

            filterInventoryByOwner(ownerFilter).forEach((line) => {
                const master = itemMasterMap.get(`${line.accountName}::${line.sku}`);
                const key = `${line.accountName}::${line.sku}`;
                const current = grouped.get(key) || {
                    owner: line.accountName,
                    sku: line.sku,
                    upc: master?.upc || line.upc || "",
                    description: master?.description || "",
                    trackingLevel: normalizeTrackingLevel(master?.trackingLevel || line.trackingLevel),
                    lineCount: 0,
                    locationSet: new Set(),
                    totalUnits: 0
                };
                if (!current.upc && line.upc) current.upc = line.upc;
                current.lineCount += 1;
                current.locationSet.add(line.location);
                current.totalUnits += line.quantity;
                grouped.set(key, current);
            });

            return [...grouped.values()]
                .map((row) => ({
                    owner: row.owner,
                    sku: row.sku,
                    upc: row.upc,
                    description: row.description,
                    trackingLevel: row.trackingLevel,
                    lineCount: row.lineCount,
                    locationCount: row.locationSet.size,
                    totalUnits: row.totalUnits
                }))
                .filter((row) => !query || row.owner.includes(query) || row.sku.includes(query) || row.upc.includes(query) || norm(row.description).includes(query))
                .sort((a, b) => a.owner.localeCompare(b.owner) || a.sku.localeCompare(b.sku));
        }

        function getOwnerReportRows(filterText = "", ownerFilter = "") {
            const query = norm(filterText);
            const scopedOwnerFilter = getScopedCompanyValue(ownerFilter);
            const grouped = new Map();

            filterInventoryByOwner(scopedOwnerFilter).forEach((line) => {
                if (!inventoryMatchesQuery(line, query)) {
                    return;
                }
                const current = grouped.get(line.accountName) || {
                    owner: line.accountName,
                    locationSet: new Set(),
                    palletLocations: new Set(),
                    totalPallets: 0,
                    unitCount: 0,
                    caseCount: 0
                };
                current.locationSet.add(line.location);
                if (normalizeTrackingLevel(line.trackingLevel) === "PALLET") {
                    current.palletLocations.add(line.location);
                    current.totalPallets += line.quantity;
                } else if (normalizeTrackingLevel(line.trackingLevel) === "CASE") {
                    current.caseCount += line.quantity;
                } else {
                    current.unitCount += line.quantity;
                }
                grouped.set(line.accountName, current);
            });

            return [...grouped.values()]
                .map((row) => ({
                    owner: row.owner,
                    locationCount: row.locationSet.size,
                    palletLocationCount: row.palletLocations.size,
                    palletLocations: [...row.palletLocations],
                    totalPallets: row.totalPallets,
                    unitCount: row.unitCount,
                    caseCount: row.caseCount,
                    quantitySummary: row.unitCount || row.caseCount ? formatTrackedSummary({ UNIT: row.unitCount, CASE: row.caseCount, PALLET: 0 }) : "-"
                }))
                .sort((a, b) => a.owner.localeCompare(b.owner));
        }

        function renderSingleSearch(query, mode, matches) {
            ui.printSingleSearchBtn.classList.toggle("hidden", !matches.length);
            ui.printMultiSearchBtn.classList.add("hidden");

            let desktopMarkup = "";
            let mobileMarkup = "";
            if (!matches.length) {
                desktopMarkup = `<p class="empty">No matching inventory lines were found for <strong>${esc(query)}</strong>.</p>`;
                setSearchResultsMarkup(desktopMarkup);
                return;
            }

            const trackedTotals = summarizeTrackedTotals(matches);
            const locations = new Set(matches.map((line) => line.location)).size;
            const skus = new Set(matches.map((line) => line.sku)).size;
            const owners = new Set(matches.map((line) => line.accountName)).size;
            const title = mode === "sku"
                ? `Showing inventory matches for <strong>${esc(query)}</strong>.`
                : `Showing inventory in locations matching <strong>${esc(query)}</strong>.`;

            desktopMarkup = `
                <div class="summary-grid">
                    <div class="summary"><span>Matched Qty</span><strong>${esc(formatTrackedSummary(trackedTotals))}</strong></div>
                    <div class="summary"><span>Matched Lines</span><strong>${num(matches.length)}</strong></div>
                    <div class="summary"><span>Locations</span><strong>${num(locations)}</strong></div>
                    <div class="summary"><span>Companies / SKUs</span><strong>${num(owners)} / ${num(skus)}</strong></div>
                </div>
                <div class="result-group">
                    <header>
                        <strong>${title}</strong>
                        <span class="muted">${num(matches.length)} line${matches.length === 1 ? "" : "s"}</span>
                    </header>
                    ${inventoryTableHtml(matches)}
                </div>
            `;
            mobileMarkup = `
                <div class="summary-grid">
                    <div class="summary"><span>Matched Qty</span><strong>${esc(formatTrackedSummary(trackedTotals))}</strong></div>
                    <div class="summary"><span>Lines</span><strong>${num(matches.length)}</strong></div>
                    <div class="summary"><span>Locations</span><strong>${num(locations)}</strong></div>
                    <div class="summary"><span>Companies / SKUs</span><strong>${num(owners)} / ${num(skus)}</strong></div>
                </div>
                <div class="result-group">
                    <header>
                        <strong>${title}</strong>
                        <span class="muted">${num(matches.length)} line${matches.length === 1 ? "" : "s"}</span>
                    </header>
                    ${inventoryMobileResultsHtml(matches)}
                </div>
            `;
            setSearchResultsMarkup(desktopMarkup, mobileMarkup);
        }

        function renderMultiSearch(groups) {
            ui.printSingleSearchBtn.classList.add("hidden");
            ui.printMultiSearchBtn.classList.toggle("hidden", !groups.some((group) => group.matches.length));

            const found = groups.filter((group) => group.matches.length).length;
            const overallTotals = groups.reduce((totals, group) => {
                totals.UNIT += group.totals.UNIT;
                totals.CASE += group.totals.CASE;
                totals.PALLET += group.totals.PALLET;
                return totals;
            }, { UNIT: 0, CASE: 0, PALLET: 0 });
            const desktopMarkup = `
                <div class="summary-grid">
                    <div class="summary"><span>Items Requested</span><strong>${num(groups.length)}</strong></div>
                    <div class="summary"><span>Items Found</span><strong>${num(found)}</strong></div>
                    <div class="summary"><span>Total Matched Qty</span><strong>${esc(formatTrackedSummary(overallTotals))}</strong></div>
                </div>
                ${groups.map((group) => group.matches.length ? `
                    <div class="result-group">
                        <header>
                            <strong>${esc(group.term)}</strong>
                            <span class="muted">${esc(formatTrackedSummary(group.totals))}</span>
                        </header>
                        ${inventoryTableHtml(group.matches)}
                    </div>
                ` : `
                    <div class="result-group">
                        <header>
                            <strong>${esc(group.term)}</strong>
                            <span class="muted">No inventory found</span>
                        </header>
                        <p class="empty">No SKU or UPC match was found for this code.</p>
                    </div>
                `).join("")}
            `;
            const mobileMarkup = `
                <div class="summary-grid">
                    <div class="summary"><span>Requested</span><strong>${num(groups.length)}</strong></div>
                    <div class="summary"><span>Found</span><strong>${num(found)}</strong></div>
                    <div class="summary"><span>Total Qty</span><strong>${esc(formatTrackedSummary(overallTotals))}</strong></div>
                </div>
                ${groups.map((group) => group.matches.length ? `
                    <div class="result-group">
                        <header>
                            <strong>${esc(group.term)}</strong>
                            <span class="muted">${esc(formatTrackedSummary(group.totals))}</span>
                        </header>
                        ${inventoryMobileResultsHtml(group.matches)}
                    </div>
                ` : `
                    <div class="result-group">
                        <header>
                            <strong>${esc(group.term)}</strong>
                            <span class="muted">No inventory found</span>
                        </header>
                        <p class="empty">No SKU or UPC match was found for this code.</p>
                    </div>
                `).join("")}
            `;
            setSearchResultsMarkup(desktopMarkup, mobileMarkup);
        }

        function setSearchResultsMarkup(desktopMarkup, mobileMarkup = desktopMarkup) {
            ui.searchResultsContent.innerHTML = desktopMarkup;
            if (ui.mobileSearchResultsContent) {
                ui.mobileSearchResultsContent.innerHTML = mobileMarkup;
            }
            updateMobileSearchResultsVisibility();
        }

        function renderActivity() {
            const company = getActiveCompany();
            const visibleActivity = company
                ? state.activity.filter((item) => norm(`${item.title} ${item.details}`).includes(company))
                : state.activity;
            if (!visibleActivity.length) {
                ui.activityList.innerHTML = `<p class="empty">Inventory and library changes will appear here after you save, delete, transfer, move, import, or add master data.</p>`;
                return;
            }
            ui.activityList.innerHTML = visibleActivity.slice(0, 12).map((item) => `
                <div class="activity-item">
                    <span class="badge ${attr(item.type)}">${esc(item.type)}</span>
                    <strong>${esc(item.title)}</strong>
                    <p>${esc(item.details)}</p>
                    <div class="activity-meta">${esc(formatDate(item.timestamp))}</div>
                </div>
            `).join("");
        }

        function renderInventory(filterText) {
            const query = norm(filterText || "");
            const matches = getScopedInventory().filter((line) => inventoryMatchesQuery(line, query));
            ui.inventoryMeta.textContent = `${num(matches.length)} matching line${matches.length === 1 ? "" : "s"}`;

            if (!matches.length) {
                ui.inventoryEmpty.textContent = query ? `No inventory lines matched "${query}".` : "No inventory saved yet. Save a batch from the Scan tab to start building inventory.";
                ui.inventoryEmpty.classList.remove("hidden");
                ui.inventoryTableWrap.classList.add("hidden");
                ui.inventoryTableBody.innerHTML = "";
                return;
            }

            ui.inventoryEmpty.classList.add("hidden");
            ui.inventoryTableWrap.classList.remove("hidden");
            ui.inventoryTableBody.innerHTML = matches.map((line) => `
                <tr>
                    <td>${esc(line.accountName)}</td>
                    <td>${esc(line.location)}</td>
                    <td>${esc(line.sku)}</td>
                    <td>${esc(line.upc || "-")}</td>
                    <td>${esc(getLineDescription(line) || "-")}</td>
                    <td>${esc(trackingLabel(line.trackingLevel))}</td>
                    <td>${num(line.quantity)}</td>
                    <td>${esc(formatDate(line.updatedAt))}</td>
                </tr>
            `).join("");
        }

        function renderSummary() {
            const scopedInventory = getScopedInventory();
            const locations = new Set(scopedInventory.map((line) => line.location)).size;
            const owners = new Set(scopedInventory.map((line) => line.accountName)).size;
            const ownerSkus = new Set(scopedInventory.map((line) => `${line.accountName}::${line.sku}`)).size;
            const trackedTotals = summarizeTrackedTotals(scopedInventory);
            ui.summaryLocations.textContent = num(locations);
            ui.summaryOwners.textContent = num(owners);
            ui.summarySkus.textContent = num(ownerSkus);
            ui.summaryUnits.textContent = formatTrackedSummary(trackedTotals);
            ui.summarySaved.textContent = state.meta.lastChangedAt ? formatDate(state.meta.lastChangedAt) : (state.meta.serverSyncedAt ? formatDate(state.meta.serverSyncedAt) : "Never");
        }

        async function removeQuantity() {
            const accountName = getScopedCompanyValue(ui.adjustAccount.value);
            const location = norm(ui.adjustLocation.value);
            const skuOrUpc = norm(ui.adjustSku.value);
            const quantity = toPositiveInt(ui.adjustQuantity.value);
            if (!accountName || !location || !skuOrUpc || !quantity) return showMessage(ui.actionMessage, "Enter company, location, SKU or UPC, and a quantity to remove.", "error");
            setActiveCompany(accountName, { force: true, rerender: false });
            const matchingLine = findClientInventoryLine(accountName, location, skuOrUpc);
            if (matchingLine?.duplicateUpc) {
                return showMessage(ui.actionMessage, "Multiple items matched that UPC in the selected location. Use the SKU instead.", "error");
            }
            if (!matchingLine) {
                return showMessage(ui.actionMessage, "That SKU or UPC is not in the selected company and location.", "error");
            }
            if (quantity > Number(matchingLine.quantity || 0)) {
                return showMessage(ui.actionMessage, `Only ${formatTrackedQuantity(Number(matchingLine.quantity || 0), matchingLine.trackingLevel || matchingLine.tracking_level || "UNIT")} are available in that location.`, "error");
            }

            try {
                await requestJson("/api/remove-quantity", {
                    method: "POST",
                    body: JSON.stringify({ accountName, location, skuOrUpc, quantity })
                });
                await syncServerState(true);
                showMessage(ui.actionMessage, "Quantity removed successfully.", "success");
                document.getElementById("adjustForm").reset();
            } catch (error) {
                showMessage(ui.actionMessage, error.message, "error");
            }
        }

        async function deleteLine() {
            const accountName = getScopedCompanyValue(ui.adjustAccount.value);
            const location = norm(ui.adjustLocation.value);
            const skuOrUpc = norm(ui.adjustSku.value);
            if (!accountName || !location || !skuOrUpc) return showMessage(ui.actionMessage, "Enter company, location, and SKU or UPC to delete the line.", "error");
            setActiveCompany(accountName, { force: true, rerender: false });
            const matchingLine = findClientInventoryLine(accountName, location, skuOrUpc);
            if (matchingLine?.duplicateUpc) {
                return showMessage(ui.actionMessage, "Multiple items matched that UPC in the selected location. Use the SKU instead.", "error");
            }
            if (!matchingLine) {
                return showMessage(ui.actionMessage, "That SKU or UPC is not in the selected company and location.", "error");
            }

            if (!window.confirm(`Delete ${accountName} / ${skuOrUpc} from ${location}?`)) return;

            try {
                await requestJson("/api/delete-line", {
                    method: "POST",
                    body: JSON.stringify({ accountName, location, skuOrUpc })
                });
                await syncServerState(true);
                showMessage(ui.actionMessage, "Inventory line deleted.", "success");
                document.getElementById("adjustForm").reset();
            } catch (error) {
                showMessage(ui.actionMessage, error.message, "error");
            }
        }

        async function transferQuantity(event) {
            event.preventDefault();
            const accountName = getScopedCompanyValue(ui.transferAccount.value);
            const from = norm(ui.transferFrom.value);
            const to = norm(ui.transferTo.value);
            const skuOrUpc = norm(ui.transferSku.value);
            const quantity = toPositiveInt(ui.transferQty.value);
            if (!accountName || !from || !to || !skuOrUpc || !quantity) return showMessage(ui.actionMessage, "Fill in company, from location, to location, SKU or UPC, and quantity.", "error");
            if (from === to) return showMessage(ui.actionMessage, "Source and destination locations cannot be the same.", "error");
            setActiveCompany(accountName, { force: true, rerender: false });
            const matchingLine = findClientInventoryLine(accountName, from, skuOrUpc);
            if (matchingLine?.duplicateUpc) {
                return showMessage(ui.actionMessage, "Multiple items matched that UPC in the source location. Use the SKU instead.", "error");
            }
            if (!matchingLine) {
                return showMessage(ui.actionMessage, "That SKU or UPC is not in the selected source location for this company.", "error");
            }
            if (quantity > Number(matchingLine.quantity || 0)) {
                return showMessage(ui.actionMessage, `Only ${formatTrackedQuantity(Number(matchingLine.quantity || 0), matchingLine.trackingLevel || matchingLine.tracking_level || "UNIT")} are available in the source location.`, "error");
            }
            const conflictingOwners = getForeignOwnersAtLocation(accountName, to);
            if (conflictingOwners.length) {
                return showMessage(ui.actionMessage, `Cannot transfer into ${to} because it already contains another company: ${conflictingOwners.join(", ")}.`, "error");
            }

            try {
                await requestJson("/api/transfer", {
                    method: "POST",
                    body: JSON.stringify({ accountName, fromLocation: from, toLocation: to, skuOrUpc, quantity })
                });
                await syncServerState(true);
                showMessage(ui.actionMessage, "Transfer completed successfully.", "success");
                document.getElementById("transferForm").reset();
            } catch (error) {
                showMessage(ui.actionMessage, error.message, "error");
            }
        }

        async function moveAllItems(event) {
            event.preventDefault();
            const accountName = getScopedCompanyValue(ui.moveAccount.value);
            const from = norm(ui.moveFrom.value);
            const to = norm(ui.moveTo.value);
            if (!accountName || !from || !to) return showMessage(ui.actionMessage, "Enter company plus both the source and destination locations.", "error");
            if (from === to) return showMessage(ui.actionMessage, "Source and destination locations cannot be the same.", "error");
            setActiveCompany(accountName, { force: true, rerender: false });
            const sourceLines = state.inventory.filter((line) => norm(line.accountName) === accountName && norm(line.location) === from);
            if (!sourceLines.length) {
                return showMessage(ui.actionMessage, "The selected source location does not have inventory for that company.", "error");
            }
            const conflictingOwners = getForeignOwnersAtLocation(accountName, to);
            if (conflictingOwners.length) {
                return showMessage(ui.actionMessage, `Cannot move into ${to} because it already contains another company: ${conflictingOwners.join(", ")}.`, "error");
            }

            try {
                await requestJson("/api/move-location", {
                    method: "POST",
                    body: JSON.stringify({ accountName, fromLocation: from, toLocation: to })
                });
                await syncServerState(true);
                showMessage(ui.actionMessage, "BIN to BIN move completed.", "success");
                document.getElementById("moveForm").reset();
            } catch (error) {
                showMessage(ui.actionMessage, error.message, "error");
            }
        }

        function printSingleSearch() {
            if (!lastSingleSearch || !lastSingleSearch.matches.length) {
                showMessage(ui.searchMessage, "Run a search before printing results.", "error");
                return;
            }
            const trackedTotals = summarizeTrackedTotals(lastSingleSearch.matches);
            openPrintWindow(
                `WMS365 Scanner - ${lastSingleSearch.mode === "sku" ? "SKU / UPC Search" : "Location Search"}`,
                `
                    <h1>WMS365 Scanner</h1>
                    <p><strong>${lastSingleSearch.mode === "sku" ? "SKU / UPC Search" : "Location Search"}</strong></p>
                    <p>Company Filter: ${esc(lastSingleSearch.ownerFilter || "ALL")}</p>
                    <p>Query: ${esc(lastSingleSearch.query)}</p>
                    <p>Matches: ${num(lastSingleSearch.matches.length)} | Total Qty: ${esc(formatTrackedSummary(trackedTotals))}</p>
                    ${printTableHtml(lastSingleSearch.matches)}
                `
            );
        }

        function printMultiSearch() {
            if (!lastMultiSearch || !lastMultiSearch.groups.length) {
                showMessage(ui.searchMessage, "Run a multi-search before printing.", "error");
                return;
            }
            openPrintWindow(
                "WMS365 Scanner - Multi Search",
                `
                    <h1>WMS365 Scanner</h1>
                    <p><strong>Multi Search Results</strong></p>
                    <p>Company Filter: ${esc(lastMultiSearch.ownerFilter || "ALL")}</p>
                    <p>Requested Items: ${num(lastMultiSearch.groups.length)}</p>
                    ${lastMultiSearch.groups.map((group) => group.matches.length ? `
                        <section>
                            <h2>${esc(group.term)}</h2>
                            <p>Total Qty: ${esc(formatTrackedSummary(group.totals))}</p>
                            ${printTableHtml(group.matches)}
                        </section>
                    ` : `
                        <section>
                            <h2>${esc(group.term)}</h2>
                            <p>No inventory found.</p>
                        </section>
                    `).join("")}
                `
            );
        }

        async function exportJson() {
            try {
                const payload = await requestJson("/api/export");
                downloadBlob(JSON.stringify(payload, null, 2), `wms365-scanner-backup-${fileStamp()}.json`, "application/json");
                showMessage(ui.backupMessage, "Server backup downloaded.", "success");
            } catch (error) {
                showMessage(ui.backupMessage, error.message, "error");
            }
        }

        async function exportCsv() {
            try {
                await syncServerState(true);
                const rows = [["Company", "Location", "SKU", "UPC", "Description", "Tracking", "Quantity", "CreatedAt", "UpdatedAt"]].concat(
                    getScopedInventory().map((line) => [
                        line.accountName,
                        line.location,
                        line.sku,
                        line.upc || "",
                        getLineDescription(line) || "",
                        line.trackingLevel,
                        String(line.quantity),
                        line.createdAt,
                        line.updatedAt
                    ])
                );
                const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
                downloadBlob(csv, `wms365-scanner-inventory-${fileStamp()}.csv`, "text/csv;charset=utf-8");
                showMessage(ui.backupMessage, "CSV snapshot downloaded.", "success");
            } catch (error) {
                showMessage(ui.backupMessage, error.message, "error");
            }
        }

        function importJson(event) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async () => {
                try {
                    const raw = JSON.parse(String(reader.result || ""));
                    const imported = sanitizeServerImport(raw.state || raw);
                    if (!window.confirm("Importing this backup will replace the shared server inventory and recent activity. Continue?")) {
                        ui.importFileInput.value = "";
                        return;
                    }

                    await requestJson("/api/import", {
                        method: "POST",
                        body: JSON.stringify(imported)
                    });

                    await syncServerState(true);
                    showMessage(ui.backupMessage, "Server backup imported successfully.", "success");
                } catch (error) {
                    showMessage(ui.backupMessage, `Import failed: ${error.message}`, "error");
                } finally {
                    ui.importFileInput.value = "";
                }
            };
            reader.onerror = () => {
                showMessage(ui.backupMessage, "Unable to read the selected file.", "error");
                ui.importFileInput.value = "";
            };
            reader.readAsText(file);
        }

        function inventoryTableHtml(lines) {
            return `
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>Company</th>
                                <th>Location</th>
                                <th>SKU</th>
                                <th>UPC</th>
                                <th>Description</th>
                                <th>Tracking</th>
                                <th>Qty</th>
                                <th>Updated</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${lines.map((line) => `
                                <tr>
                                    <td>${esc(line.accountName)}</td>
                                    <td>${esc(line.location)}</td>
                                    <td>${esc(line.sku)}</td>
                                    <td>${esc(line.upc || "-")}</td>
                                    <td>${esc(getLineDescription(line) || "-")}</td>
                                    <td>${esc(trackingLabel(line.trackingLevel))}</td>
                                    <td>${num(line.quantity)}</td>
                                    <td>${esc(formatDate(line.updatedAt))}</td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </div>
            `;
        }

        function inventoryMobileResultsHtml(lines) {
            return `
                <div class="mobile-result-list">
                    ${lines.map((line) => `
                        <article class="mobile-result-card">
                            <div class="mobile-result-head">
                                <div>
                                    <span class="mobile-result-owner">${esc(line.accountName)}</span>
                                    <strong class="mobile-result-sku">${esc(line.sku)}</strong>
                                </div>
                                <span class="mobile-result-location">${esc(line.location)}</span>
                            </div>
                            ${(line.upc || "").trim() ? `<div class="mobile-result-upc">UPC ${esc(line.upc)}</div>` : ""}
                            ${getLineDescription(line) ? `<div class="mobile-result-desc">${esc(getLineDescription(line))}</div>` : ""}
                            <div class="mobile-result-stats">
                                <div class="mobile-result-stat">
                                    <span>Tracking</span>
                                    <strong>${esc(trackingLabel(line.trackingLevel))}</strong>
                                </div>
                                <div class="mobile-result-stat">
                                    <span>Qty</span>
                                    <strong>${esc(formatTrackedQuantity(line.quantity, line.trackingLevel))}</strong>
                                </div>
                                <div class="mobile-result-stat">
                                    <span>Updated</span>
                                    <strong>${esc(formatDate(line.updatedAt))}</strong>
                                </div>
                            </div>
                        </article>
                    `).join("")}
                </div>
            `;
        }

        function printTableHtml(lines) {
            return `
                <table>
                    <thead>
                        <tr>
                            <th>Company</th>
                            <th>Location</th>
                            <th>SKU</th>
                            <th>UPC</th>
                            <th>Description</th>
                            <th>Tracking</th>
                            <th>Qty</th>
                            <th>Updated</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${lines.map((line) => `
                            <tr>
                                <td>${esc(line.accountName)}</td>
                                <td>${esc(line.location)}</td>
                                <td>${esc(line.sku)}</td>
                                <td>${esc(line.upc || "-")}</td>
                                <td>${esc(getLineDescription(line) || "-")}</td>
                                <td>${esc(trackingLabel(line.trackingLevel))}</td>
                                <td>${num(line.quantity)}</td>
                                <td>${esc(formatDate(line.updatedAt))}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            `;
        }

        function openPrintWindow(title, body) {
            const popup = window.open("", "_blank", "width=980,height=720");
            if (!popup) {
                showMessage(ui.searchMessage, "Pop-up blocking prevented the print preview from opening.", "error");
                return;
            }
            popup.document.write(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <title>${esc(title)}</title>
                    <style>
                        body { font-family: Arial, sans-serif; margin: 24px; color: #12283c; }
                        h1, h2 { margin: 0 0 12px; }
                        p { margin: 0 0 10px; line-height: 1.5; }
                        section { margin-top: 20px; page-break-inside: avoid; }
                        table { width: 100%; border-collapse: collapse; margin-top: 12px; }
                        th, td { border: 1px solid #bfd0de; padding: 8px 10px; text-align: left; }
                        th { background: #ebf4fb; text-transform: uppercase; font-size: 12px; letter-spacing: 0.08em; }
                    </style>
                </head>
                <body>${body}</body>
                </html>
            `);
            popup.document.close();
            popup.focus();
            setTimeout(() => popup.print(), 250);
        }

        function sortedInventory() {
            return [...state.inventory].sort((a, b) => a.accountName.localeCompare(b.accountName) || a.location.localeCompare(b.location) || a.sku.localeCompare(b.sku));
        }

        async function syncServerState(silent = false) {
            try {
                const payload = await requestJson("/api/state");
                applyServerState(payload);
                return payload;
            } catch (error) {
                if (!silent) {
                    showMessage(ui.scanMessage, error.message, "error");
                    showMessage(ui.searchMessage, error.message, "error");
                }
                throw error;
            }
        }

        function applyServerState(payload) {
            state.inventory = Array.isArray(payload?.inventory) ? payload.inventory.map(sanitizeInventoryLine).filter(Boolean) : [];
            state.pallets = Array.isArray(payload?.pallets) ? payload.pallets.map(sanitizePalletRecord).filter(Boolean) : [];
            state.activity = Array.isArray(payload?.activity) ? payload.activity.map(sanitizeActivityItem).filter(Boolean) : [];
            state.masters.locations = Array.isArray(payload?.masters?.locations) ? payload.masters.locations.map(sanitizeMasterLocation).filter(Boolean) : [];
            state.masters.ownerRecords = Array.isArray(payload?.masters?.ownerRecords) ? payload.masters.ownerRecords.map(sanitizeMasterOwner).filter(Boolean) : [];
            state.masters.items = Array.isArray(payload?.masters?.items) ? payload.masters.items.map(sanitizeMasterItem).filter(Boolean) : [];
            state.masters.owners = Array.isArray(payload?.masters?.owners)
                ? payload.masters.owners.map((owner) => norm(owner)).filter(Boolean)
                : getOwnerOptions();
            state.billing.feeCatalog = Array.isArray(payload?.billing?.feeCatalog) ? payload.billing.feeCatalog.map(sanitizeBillingFee).filter(Boolean) : [];
            state.billing.ownerRates = Array.isArray(payload?.billing?.ownerRates) ? payload.billing.ownerRates.map(sanitizeOwnerBillingRate).filter(Boolean) : [];
            state.billing.events = Array.isArray(payload?.billing?.events) ? payload.billing.events.map(sanitizeBillingEvent).filter(Boolean) : [];
            state.meta.lastChangedAt = typeof payload?.meta?.lastChangedAt === "string" ? payload.meta.lastChangedAt : null;
            state.meta.serverSyncedAt = typeof payload?.meta?.serverSyncedAt === "string" ? payload.meta.serverSyncedAt : new Date().toISOString();
            state.meta.localCacheAt = new Date().toISOString();
            saveState({ includeCache: true });
            renderAll();
            updateWorkspaceCommandBar();
            refreshSearchFromCurrentState();
        }

        async function requestJson(url, options = {}) {
            const response = await fetch(url, {
                headers: {
                    "Content-Type": "application/json",
                    ...(options.headers || {})
                },
                ...options
            });
            const text = await response.text();
            const data = text ? JSON.parse(text) : {};
            if (!response.ok) {
                throw new Error(data.error || "Request failed.");
            }
            return data;
        }

        function normalizeImageReference(value) {
            const text = String(value || "").trim();
            if (!text) return "";
            if (/^data:image\//i.test(text)) return text;
            const driveId = extractDriveFileId(text);
            if (driveId) return `https://drive.google.com/thumbnail?id=${driveId}&sz=w1600`;
            return text;
        }

        function stripLargeLocalImage(value) {
            const normalized = normalizeImageReference(value);
            return /^data:image\//i.test(normalized) ? "" : normalized;
        }

        function extractDriveFileId(value) {
            const text = String(value || "").trim();
            if (!text) return "";
            const match = text.match(/\/file\/d\/([A-Za-z0-9_-]+)/)
                || text.match(/[?&]id=([A-Za-z0-9_-]+)/)
                || text.match(/\/thumbnail\?id=([A-Za-z0-9_-]+)/);
            return match ? match[1] : "";
        }

        function clearImageField({ urlInput, previewWrap, previewImg, previewMeta, clearBtn, defaultMeta }) {
            if (urlInput) urlInput.value = "";
            if (previewImg) previewImg.removeAttribute("src");
            if (previewWrap) previewWrap.classList.add("hidden");
            if (clearBtn) clearBtn.classList.add("hidden");
            if (previewMeta) previewMeta.textContent = defaultMeta || "";
        }

        function refreshImagePreview({ urlInput, previewWrap, previewImg, previewMeta, clearBtn, defaultMeta }) {
            const normalized = normalizeImageReference(urlInput?.value);
            if (!normalized) {
                clearImageField({ urlInput, previewWrap, previewImg, previewMeta, clearBtn, defaultMeta });
                return "";
            }
            if (urlInput) urlInput.value = normalized;
            if (previewImg) previewImg.src = normalized;
            if (previewWrap) previewWrap.classList.remove("hidden");
            if (clearBtn) clearBtn.classList.remove("hidden");
            if (previewMeta) {
                previewMeta.textContent = normalized.startsWith("data:image/")
                    ? "Compressed photo ready to save with this item."
                    : "Image link ready to save with this item.";
            }
            return normalized;
        }

        async function handleImageInputChange(event, options) {
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            try {
                const compressedImage = await compressImageFile(file);
                options.urlInput.value = compressedImage;
                refreshImagePreview(options);
                if (options.messageElement) {
                    showMessage(options.messageElement, "Photo compressed and attached to this item.", "success");
                }
            } catch (error) {
                if (options.messageElement) {
                    showMessage(options.messageElement, error.message, "error");
                }
            } finally {
                event.target.value = "";
            }
        }

        function compressImageFile(file, { maxWidth = 900, maxHeight = 900, quality = 0.72 } = {}) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => {
                    const image = new Image();
                    image.onload = () => {
                        const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height);
                        const width = Math.max(1, Math.round(image.width * scale));
                        const height = Math.max(1, Math.round(image.height * scale));
                        const canvas = document.createElement("canvas");
                        canvas.width = width;
                        canvas.height = height;
                        const context = canvas.getContext("2d");
                        if (!context) {
                            reject(new Error("Image compression is not available in this browser."));
                            return;
                        }
                        context.fillStyle = "#ffffff";
                        context.fillRect(0, 0, width, height);
                        context.drawImage(image, 0, 0, width, height);
                        resolve(canvas.toDataURL("image/jpeg", quality));
                    };
                    image.onerror = () => reject(new Error("The selected image could not be loaded."));
                    image.src = String(reader.result || "");
                };
                reader.onerror = () => reject(new Error("The selected image could not be read."));
                reader.readAsDataURL(file);
            });
        }

        async function readPortalShippingDocuments(fileList) {
            const files = Array.from(fileList || []).filter(Boolean);
            if (!files.length) return [];
            if (files.length > 5) {
                throw new Error("Upload up to 5 shipped documents at a time.");
            }

            const documents = [];
            for (const file of files) {
                const fileType = String(file.type || "").toLowerCase();
                if (!(fileType === "application/pdf" || fileType.startsWith("image/"))) {
                    throw new Error(`${file.name} must be a PDF or image file.`);
                }
                const dataUrl = fileType.startsWith("image/")
                    ? await compressImageFile(file, { maxWidth: 1600, maxHeight: 1600, quality: 0.76 })
                    : await readFileAsDataUrl(file);
                documents.push({
                    fileName: file.name,
                    fileType: fileType || "application/octet-stream",
                    dataUrl
                });
            }
            return documents;
        }

        function readFileAsDataUrl(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ""));
                reader.onerror = () => reject(new Error(`Unable to read ${file?.name || "the file"}.`));
                reader.readAsDataURL(file);
            });
        }

        function loadState() {
            try {
                const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
                return raw ? sanitizeLocalState(JSON.parse(raw)) : defaultState();
            } catch {
                return defaultState();
            }
        }

        function loadLabelToolState() {
            try {
                const raw = localStorage.getItem(LABEL_TOOL_STORAGE_KEY);
                return raw ? sanitizeLabelToolState(JSON.parse(raw)) : defaultLabelToolState();
            } catch {
                return defaultLabelToolState();
            }
        }

        function defaultState() {
            return {
                inventory: [],
                pallets: [],
                batch: [],
                activity: [],
                masters: { locations: [], ownerRecords: [], items: [], owners: [] },
                billing: { feeCatalog: [], ownerRates: [], events: [] },
                preferences: { lastLocation: "", lastAccount: "", activeCompany: "", desktopMobilePreview: false },
                meta: { version: 7, lastChangedAt: null, serverSyncedAt: null, localCacheAt: null }
            };
        }

        function defaultLabelToolState() {
            return {
                mode: "location",
                rack: "106",
                bin: "01",
                level: 1,
                side: "1",
                bulk: "",
                filter: "",
                labels: [],
                palletCode: "",
                palletAccount: "",
                palletSku: "",
                palletDescription: "",
                palletCases: "",
                palletDate: todayInputValue(),
                palletLocation: "",
                palletLabels: []
            };
        }

        function sanitizeLabelToolState(raw) {
            const base = defaultLabelToolState();
            return {
                mode: raw?.mode === "pallet" ? "pallet" : "location",
                rack: sanitizeLabelDigits(raw?.rack, 3) || base.rack,
                bin: sanitizeLabelDigits(raw?.bin, 2) || base.bin,
                level: sanitizeLabelLevel(raw?.level),
                side: sanitizeLabelSide(raw?.side),
                bulk: typeof raw?.bulk === "string" ? raw.bulk : "",
                filter: typeof raw?.filter === "string" ? raw.filter.trim().toUpperCase() : "",
                labels: Array.isArray(raw?.labels) ? raw.labels.map(normalizeLocationLabelCode).filter(Boolean) : [],
                palletCode: typeof raw?.palletCode === "string" ? norm(raw.palletCode) : "",
                palletAccount: typeof raw?.palletAccount === "string" ? norm(raw.palletAccount) : "",
                palletSku: typeof raw?.palletSku === "string" ? norm(raw.palletSku) : "",
                palletDescription: typeof raw?.palletDescription === "string" ? raw.palletDescription.trim().replace(/\s+/g, " ") : "",
                palletCases: raw?.palletCases == null ? "" : String(raw.palletCases).trim(),
                palletDate: normalizeLabelDate(raw?.palletDate) || base.palletDate,
                palletLocation: typeof raw?.palletLocation === "string" ? norm(raw.palletLocation) : "",
                palletLabels: Array.isArray(raw?.palletLabels) ? raw.palletLabels.map(sanitizePalletLabelEntry).filter(Boolean) : []
            };
        }

        function sanitizeLocalState(raw) {
            const cache = sanitizeLocalCache(raw?.cache);
            return {
                inventory: cache.inventory,
                pallets: cache.pallets,
                batch: Array.isArray(raw.batch) ? raw.batch.map(sanitizeBatchLine).filter(Boolean) : [],
                activity: cache.activity,
                masters: cache.masters,
                billing: cache.billing,
                preferences: {
                    lastLocation: typeof raw.preferences?.lastLocation === "string" ? norm(raw.preferences.lastLocation) : "",
                    lastAccount: typeof raw.preferences?.lastAccount === "string" ? norm(raw.preferences.lastAccount) : "",
                    activeCompany: typeof raw.preferences?.activeCompany === "string"
                        ? norm(raw.preferences.activeCompany)
                        : (typeof raw.preferences?.lastAccount === "string" ? norm(raw.preferences.lastAccount) : ""),
                    desktopMobilePreview: raw.preferences?.desktopMobilePreview === true
                },
                meta: {
                    version: 7,
                    lastChangedAt: cache.meta.lastChangedAt,
                    serverSyncedAt: cache.meta.serverSyncedAt,
                    localCacheAt: cache.meta.localCacheAt
                }
            };
        }

        function sanitizeLocalCache(raw) {
            return {
                inventory: Array.isArray(raw?.inventory) ? raw.inventory.map(sanitizeInventoryLine).filter(Boolean) : [],
                pallets: Array.isArray(raw?.pallets) ? raw.pallets.map(sanitizePalletRecord).filter(Boolean) : [],
                activity: Array.isArray(raw?.activity) ? raw.activity.map(sanitizeActivityItem).filter(Boolean) : [],
                masters: {
                    locations: Array.isArray(raw?.masters?.locations) ? raw.masters.locations.map(sanitizeMasterLocation).filter(Boolean) : [],
                    ownerRecords: Array.isArray(raw?.masters?.ownerRecords) ? raw.masters.ownerRecords.map(sanitizeMasterOwner).filter(Boolean) : [],
                    items: Array.isArray(raw?.masters?.items) ? raw.masters.items.map(sanitizeMasterItem).filter(Boolean) : [],
                    owners: Array.isArray(raw?.masters?.owners) ? raw.masters.owners.map((owner) => norm(owner)).filter(Boolean) : []
                },
                billing: {
                    feeCatalog: Array.isArray(raw?.billing?.feeCatalog) ? raw.billing.feeCatalog.map(sanitizeBillingFee).filter(Boolean) : [],
                    ownerRates: Array.isArray(raw?.billing?.ownerRates) ? raw.billing.ownerRates.map(sanitizeOwnerBillingRate).filter(Boolean) : [],
                    events: Array.isArray(raw?.billing?.events) ? raw.billing.events.map(sanitizeBillingEvent).filter(Boolean) : []
                },
                meta: {
                    lastChangedAt: typeof raw?.meta?.lastChangedAt === "string" ? raw.meta.lastChangedAt : null,
                    serverSyncedAt: typeof raw?.meta?.serverSyncedAt === "string" ? raw.meta.serverSyncedAt : null,
                    localCacheAt: typeof raw?.meta?.localCacheAt === "string" ? raw.meta.localCacheAt : null
                }
            };
        }

        function sanitizeServerImport(raw) {
            return {
                inventory: Array.isArray(raw.inventory) ? raw.inventory.map(sanitizeInventoryLine).filter(Boolean) : [],
                pallets: Array.isArray(raw?.pallets) ? raw.pallets.map(sanitizePalletRecord).filter(Boolean) : [],
                activity: Array.isArray(raw.activity) ? raw.activity.map(sanitizeActivityItem).filter(Boolean) : [],
                masters: {
                    locations: Array.isArray(raw?.masters?.locations) ? raw.masters.locations.map(sanitizeMasterLocation).filter(Boolean) : [],
                    ownerRecords: Array.isArray(raw?.masters?.ownerRecords)
                        ? raw.masters.ownerRecords.map(sanitizeMasterOwner).filter(Boolean)
                        : Array.isArray(raw?.masters?.owners)
                            ? raw.masters.owners.map(sanitizeMasterOwner).filter(Boolean)
                            : [],
                    items: Array.isArray(raw?.masters?.items) ? raw.masters.items.map(sanitizeMasterItem).filter(Boolean) : [],
                    owners: Array.isArray(raw?.masters?.owners) ? raw.masters.owners.map((owner) => norm(owner)).filter(Boolean) : []
                },
                billing: {
                    feeCatalog: Array.isArray(raw?.billing?.feeCatalog) ? raw.billing.feeCatalog.map(sanitizeBillingFee).filter(Boolean) : [],
                    ownerRates: Array.isArray(raw?.billing?.ownerRates) ? raw.billing.ownerRates.map(sanitizeOwnerBillingRate).filter(Boolean) : [],
                    events: Array.isArray(raw?.billing?.events) ? raw.billing.events.map(sanitizeBillingEvent).filter(Boolean) : []
                }
            };
        }

        function refreshSearchFromCurrentState() {
            if (activeSection !== "search" || !currentSearchView) return;

            if (currentSearchView.kind === "single") {
                const matches = filterInventoryByOwner(currentSearchView.ownerFilter).filter((line) => currentSearchView.mode === "sku"
                    ? line.sku.includes(currentSearchView.query) || (line.upc || "").includes(currentSearchView.query)
                    : line.location.includes(currentSearchView.query)
                );
                lastSingleSearch = { mode: currentSearchView.mode, query: currentSearchView.query, ownerFilter: currentSearchView.ownerFilter, matches };
                lastMultiSearch = null;
                renderSingleSearch(currentSearchView.query, currentSearchView.mode, matches);
                return;
            }

            const groups = currentSearchView.terms.map((term) => {
                const matches = filterInventoryByOwner(currentSearchView.ownerFilter).filter((line) => line.sku.includes(term) || (line.upc || "").includes(term));
                return { term, matches, totals: summarizeTrackedTotals(matches) };
            });
            lastMultiSearch = { terms: currentSearchView.terms, ownerFilter: currentSearchView.ownerFilter, groups };
            lastSingleSearch = null;
            renderMultiSearch(groups);
        }

        function sanitizeInventoryLine(line) {
            const accountName = norm(line?.accountName || line?.owner || line?.vendor || line?.customer || "LEGACY");
            const location = norm(line?.location);
            const sku = norm(line?.sku);
            const upc = norm(line?.upc || "");
            const trackingLevel = normalizeTrackingLevel(line?.trackingLevel);
            const quantity = toPositiveInt(line?.quantity);
            if (!accountName || !location || !sku || !quantity) return null;
            return {
                id: typeof line.id === "string" ? line.id : makeId("inv"),
                accountName,
                location,
                sku,
                upc,
                trackingLevel,
                quantity,
                createdAt: typeof line.createdAt === "string" ? line.createdAt : new Date().toISOString(),
                updatedAt: typeof line.updatedAt === "string" ? line.updatedAt : new Date().toISOString()
            };
        }

        function sanitizePalletRecord(entry) {
            const palletCode = norm(entry?.palletCode || entry?.code || entry?.palletId || entry?.pallet_id);
            const accountName = norm(entry?.accountName || entry?.owner || entry?.vendor || entry?.customer);
            const sku = norm(entry?.sku);
            const cases = toPositiveInt(entry?.cases ?? entry?.casesOnPallet);
            const date = normalizeLabelDate(entry?.date || entry?.labelDate) || todayInputValue();
            if (!palletCode || !accountName || !sku || !cases || !date) return null;
            return {
                id: typeof entry?.id === "string" ? entry.id : makeId("pallet"),
                palletCode,
                accountName,
                sku,
                upc: norm(entry?.upc || ""),
                description: String(entry?.description || "").trim().replace(/\s+/g, " "),
                cases,
                date,
                location: norm(entry?.location || ""),
                inventoryTrackingLevel: normalizeTrackingLevel(entry?.inventoryTrackingLevel || entry?.trackingLevel),
                inventoryQuantity: toPositiveInt(entry?.inventoryQuantity) || 0,
                createdAt: typeof entry?.createdAt === "string" ? entry.createdAt : new Date().toISOString(),
                updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : new Date().toISOString()
            };
        }

        function sanitizeBatchLine(line) {
            const accountName = norm(line?.accountName || line?.owner || line?.vendor || line?.customer || "LEGACY");
            const location = norm(line?.location);
            const sku = norm(line?.sku);
            const upc = norm(line?.upc || "");
            const trackingLevel = normalizeTrackingLevel(line?.trackingLevel);
            const quantity = toPositiveInt(line?.quantity);
            if (!accountName || !location || !sku || !quantity) return null;
            return {
                id: typeof line.id === "string" ? line.id : makeId("batch"),
                accountName,
                location,
                sku,
                upc,
                description: String(line?.description || "").trim().replace(/\s+/g, " "),
                imageUrl: normalizeImageReference(line?.imageUrl || line?.image || line?.photoUrl || line?.image_url || ""),
                trackingLevel,
                quantity,
                addedAt: typeof line.addedAt === "string" ? line.addedAt : new Date().toISOString()
            };
        }

        function sanitizeActivityItem(item) {
            const title = typeof item?.title === "string" ? item.title.trim() : "";
            if (!title) return null;
            return {
                id: typeof item.id === "string" ? item.id : makeId("activity"),
                type: typeof item.type === "string" ? item.type.toLowerCase() : "scan",
                title,
                details: typeof item.details === "string" ? item.details.trim() : "",
                timestamp: typeof item.timestamp === "string" ? item.timestamp : new Date().toISOString()
            };
        }

        function sanitizeMasterLocation(item) {
            const code = norm(item?.code ?? item?.location);
            if (!code) return null;
            return {
                id: typeof item.id === "string" ? item.id : makeId("loc"),
                code,
                note: String(item?.note || "").trim().replace(/\s+/g, " "),
                createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
                updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
            };
        }

        function sanitizeMasterOwner(item) {
            const value = typeof item === "string" ? item : item?.name ?? item?.owner ?? item?.vendor ?? item?.customer;
            const name = norm(value);
            if (!name) return null;
            return {
                id: typeof item?.id === "string" ? item.id : makeId("owner"),
                name,
                legalName: String(item?.legalName || item?.legal_name || "").trim().replace(/\s+/g, " "),
                accountCode: norm(item?.accountCode || item?.account_code || ""),
                contactName: String(item?.contactName || item?.contact_name || "").trim().replace(/\s+/g, " "),
                contactTitle: String(item?.contactTitle || item?.contact_title || "").trim().replace(/\s+/g, " "),
                email: norm(String(item?.email || "").toLowerCase()),
                phone: String(item?.phone || "").trim().replace(/\s+/g, " "),
                mobile: String(item?.mobile || item?.cell || "").trim().replace(/\s+/g, " "),
                website: String(item?.website || "").trim(),
                billingEmail: norm(String(item?.billingEmail || item?.billing_email || "").toLowerCase()),
                apEmail: norm(String(item?.apEmail || item?.ap_email || "").toLowerCase()),
                portalLoginEmail: norm(String(item?.portalLoginEmail || item?.portal_login_email || item?.portalEmail || "").toLowerCase()),
                address1: String(item?.address1 || item?.address_1 || "").trim().replace(/\s+/g, " "),
                address2: String(item?.address2 || item?.address_2 || "").trim().replace(/\s+/g, " "),
                city: String(item?.city || "").trim().replace(/\s+/g, " "),
                state: String(item?.state || item?.province || "").trim().replace(/\s+/g, " "),
                postalCode: norm(item?.postalCode || item?.postal_code || item?.zip || ""),
                country: String(item?.country || "").trim().replace(/\s+/g, " "),
                isActive: item?.isActive !== false,
                note: String(typeof item === "string" ? "" : item?.note || "").trim().replace(/\s+/g, " "),
                createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
                updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
            };
        }

        function sanitizePortalAccessRecord(item) {
            const accountName = norm(item?.accountName || item?.owner || item?.vendor || item?.customer);
            if (!accountName) return null;
            return {
                id: typeof item?.id === "string" ? item.id : makeId("portal"),
                accountName,
                email: norm(String(item?.email || "").toLowerCase()),
                isActive: item?.isActive !== false,
                lastLoginAt: typeof item?.lastLoginAt === "string" ? item.lastLoginAt : null,
                createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
                updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
            };
        }

        function sanitizePortalOrderRecord(item) {
            const accountName = norm(item?.accountName || item?.account_name || item?.owner || item?.vendor || item?.customer);
            if (!item?.id || !accountName) return null;
            return {
                id: String(item.id),
                orderCode: String(item.orderCode || "").trim(),
                accountName,
                status: norm(item.status || "DRAFT"),
                poNumber: String(item.poNumber || "").trim(),
                shippingReference: String(item.shippingReference || "").trim(),
                contactName: String(item.contactName || "").trim(),
                contactPhone: String(item.contactPhone || "").trim(),
                requestedShipDate: String(item.requestedShipDate || item.requested_ship_date || "").trim(),
                orderNotes: String(item.orderNotes || item.order_notes || "").trim(),
                shipToName: String(item.shipToName || "").trim(),
                shipToAddress1: String(item.shipToAddress1 || "").trim(),
                shipToCity: String(item.shipToCity || "").trim(),
                shipToState: String(item.shipToState || "").trim(),
                shipToPostalCode: String(item.shipToPostalCode || "").trim(),
                confirmedShipDate: String(item.confirmedShipDate || item.confirmed_ship_date || "").trim(),
                shippedCarrierName: String(item.shippedCarrierName || item.shipped_carrier_name || "").trim(),
                shippedTrackingReference: String(item.shippedTrackingReference || item.shipped_tracking_reference || "").trim(),
                shippedConfirmationNote: String(item.shippedConfirmationNote || item.shipped_confirmation_note || "").trim(),
                createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
                releasedAt: typeof item.releasedAt === "string" ? item.releasedAt : null,
                pickedAt: typeof item.pickedAt === "string" ? item.pickedAt : null,
                stagedAt: typeof item.stagedAt === "string" ? item.stagedAt : null,
                shippedAt: typeof item.shippedAt === "string" ? item.shippedAt : null,
                documents: Array.isArray(item.documents)
                    ? item.documents.map((document) => sanitizePortalOrderDocumentRecord(document)).filter(Boolean)
                    : [],
                lines: Array.isArray(item.lines) ? item.lines.map(sanitizePortalOrderLineRecord).filter(Boolean) : []
            };
        }

        function sanitizePortalOrderDocumentRecord(item) {
            if (!item?.id) return null;
            const downloadUrl = String(item.downloadUrl || item.download_url || "").trim();
            if (!downloadUrl) return null;
            return {
                id: String(item.id),
                fileName: String(item.fileName || item.file_name || "Document").trim() || "Document",
                fileType: String(item.fileType || item.file_type || "").trim(),
                fileSize: Number(item.fileSize || item.file_size || 0) || 0,
                uploadedBy: String(item.uploadedBy || item.uploaded_by || "").trim(),
                createdAt: typeof item.createdAt === "string" ? item.createdAt : (typeof item.created_at === "string" ? item.created_at : ""),
                downloadUrl
            };
        }

        function sanitizePortalOrderLineRecord(item) {
            const sku = norm(item?.sku);
            const quantity = toPositiveInt(item?.quantity);
            if (!sku || !quantity) return null;
            return {
                sku,
                quantity,
                description: String(item?.description || item?.itemDescription || "").trim(),
                upc: String(item?.upc || "").trim(),
                trackingLevel: normalizeTrackingLevel(item?.trackingLevel),
                onHandQuantity: Number(item?.onHandQuantity || item?.on_hand_quantity || 0) || 0,
                availableQuantity: Number(item?.availableQuantity || item?.available_quantity || 0) || 0,
                pickLocations: Array.isArray(item?.pickLocations)
                    ? item.pickLocations.map((entry) => ({
                        location: norm(entry?.location || ""),
                        quantity: Number(entry?.quantity || 0) || 0,
                        trackingLevel: normalizeTrackingLevel(entry?.trackingLevel || item?.trackingLevel)
                    })).filter((entry) => entry.location)
                    : []
            };
        }

        function sanitizeMasterItem(item) {
            const accountName = norm(item?.accountName || item?.owner || item?.vendor || item?.customer || "LEGACY");
            const sku = norm(item?.sku);
            if (!accountName || !sku) return null;
            return {
                id: typeof item.id === "string" ? item.id : makeId("item"),
                accountName,
                sku,
                upc: norm(item?.upc || ""),
                description: String(item?.description || "").trim().replace(/\s+/g, " "),
                trackingLevel: normalizeTrackingLevel(item?.trackingLevel),
                unitsPerCase: toPositiveInt(item?.unitsPerCase),
                eachLength: toPositiveNumber(item?.eachLength),
                eachWidth: toPositiveNumber(item?.eachWidth),
                eachHeight: toPositiveNumber(item?.eachHeight),
                imageUrl: normalizeImageReference(item?.imageUrl || item?.image || item?.photoUrl || item?.image_url || ""),
                caseLength: toPositiveNumber(item?.caseLength),
                caseWidth: toPositiveNumber(item?.caseWidth),
                caseHeight: toPositiveNumber(item?.caseHeight),
                createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
                updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
            };
        }

        function sanitizeBillingFee(item) {
            const code = norm(item?.code);
            if (!code) return null;
            return {
                code,
                category: String(item?.category || "").trim(),
                name: String(item?.name || "").trim(),
                unitLabel: String(item?.unitLabel || item?.unit_label || "").trim(),
                defaultRate: toNumber(item?.defaultRate ?? item?.default_rate),
                isActive: item?.isActive !== false,
                createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
                updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
            };
        }

        function sanitizeOwnerBillingRate(item) {
            const accountName = norm(item?.accountName || item?.owner || item?.vendor || item?.customer);
            const feeCode = norm(item?.feeCode || item?.code);
            if (!accountName || !feeCode) return null;
            return {
                id: typeof item?.id === "string" ? item.id : makeId("bill-rate"),
                accountName,
                feeCode,
                rate: toNumber(item?.rate),
                isEnabled: item?.isEnabled === true || item?.enabled === true,
                unitLabel: String(item?.unitLabel || item?.unit_label || "").trim(),
                note: String(item?.note || "").trim(),
                createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
                updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
            };
        }

        function sanitizeBillingEvent(item) {
            const id = item?.id != null ? String(item.id) : "";
            const accountName = norm(item?.accountName || item?.owner || item?.vendor || item?.customer);
            const feeCode = norm(item?.feeCode || item?.code);
            if (!id || !accountName || !feeCode) return null;
            const status = norm(item?.status || "OPEN");
            return {
                id,
                eventKey: String(item?.eventKey || "").trim(),
                accountName,
                feeCode,
                feeCategory: String(item?.feeCategory || item?.category || "").trim(),
                feeName: String(item?.feeName || item?.name || "").trim(),
                unitLabel: String(item?.unitLabel || item?.unit_label || "").trim(),
                quantity: toNumber(item?.quantity),
                rate: toNumber(item?.rate),
                amount: toNumber(item?.amount),
                currencyCode: norm(item?.currencyCode || item?.currency_code || "USD") || "USD",
                serviceDate: normalizeLabelDate(item?.serviceDate || item?.date) || todayInputValue(),
                status: ["OPEN", "INVOICED", "VOID"].includes(status) ? status : "OPEN",
                invoiceNumber: String(item?.invoiceNumber || item?.invoice_number || "").trim(),
                invoicedAt: typeof item?.invoicedAt === "string" ? item.invoicedAt : null,
                sourceType: String(item?.sourceType || item?.source_type || "").trim(),
                sourceRef: String(item?.sourceRef || item?.source_ref || "").trim(),
                reference: String(item?.reference || "").trim(),
                note: String(item?.note || "").trim(),
                metadata: item?.metadata && typeof item.metadata === "object" && !Array.isArray(item.metadata) ? item.metadata : {},
                createdAt: typeof item?.createdAt === "string" ? item.createdAt : new Date().toISOString(),
                updatedAt: typeof item?.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
            };
        }

        function saveState({ includeCache = false } = {}) {
            let existing = {};
            try {
                existing = JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY) || "{}") || {};
            } catch {
                existing = {};
            }

            const payload = {
                batch: state.batch,
                preferences: state.preferences,
                cache: includeCache ? buildLocalCachePayload() : existing.cache
            };
            try {
                localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
            } catch {
                try {
                    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify({
                        batch: state.batch.map((line) => ({ ...line, imageUrl: "" })),
                        preferences: state.preferences,
                        cache: includeCache ? buildLocalCachePayload({ compact: true }) : existing.cache
                    }));
                } catch {
                    // Ignore local storage write failures. The shared server remains the source of truth.
                }
            }
        }

        function buildLocalCachePayload({ compact = false } = {}) {
            const cachedItems = state.masters.items.map((item) => ({
                ...item,
                imageUrl: stripLargeLocalImage(item.imageUrl)
            }));

            return {
                inventory: state.inventory,
                pallets: state.pallets,
                activity: compact ? [] : state.activity.slice(0, LOCAL_CACHE_ACTIVITY_LIMIT),
                masters: {
                    locations: state.masters.locations,
                    ownerRecords: state.masters.ownerRecords,
                    items: cachedItems,
                    owners: state.masters.owners
                },
                billing: {
                    feeCatalog: state.billing.feeCatalog,
                    ownerRates: state.billing.ownerRates,
                    events: compact ? state.billing.events.slice(0, 200) : state.billing.events
                },
                meta: {
                    lastChangedAt: state.meta.lastChangedAt,
                    serverSyncedAt: state.meta.serverSyncedAt,
                    localCacheAt: new Date().toISOString()
                }
            };
        }

        function saveLabelToolState() {
            try {
                localStorage.setItem(LABEL_TOOL_STORAGE_KEY, JSON.stringify({
                    mode: labelToolState.mode,
                    rack: labelToolState.rack,
                    bin: labelToolState.bin,
                    level: labelToolState.level,
                    side: labelToolState.side,
                    bulk: labelToolState.bulk,
                    filter: labelToolState.filter,
                    labels: labelToolState.labels,
                    palletCode: labelToolState.palletCode,
                    palletAccount: labelToolState.palletAccount,
                    palletSku: labelToolState.palletSku,
                    palletDescription: labelToolState.palletDescription,
                    palletCases: labelToolState.palletCases,
                    palletDate: labelToolState.palletDate,
                    palletLocation: labelToolState.palletLocation,
                    palletLabels: labelToolState.palletLabels
                }));
            } catch {
                // Ignore device-local label queue save failures.
            }
        }

        function showMessage(element, text, tone) {
            element.textContent = text;
            element.className = `status show ${tone}`;
        }

        function fail(element, text, focusEl) {
            showMessage(element, text, "error");
            if (focusEl) focusEl.focus();
            return null;
        }

        function toPositiveInt(value) {
            const numValue = Number.parseInt(String(value), 10);
            return Number.isFinite(numValue) && numValue > 0 ? numValue : null;
        }

        function toPositiveNumber(value) {
            const numValue = Number.parseFloat(String(value));
            return Number.isFinite(numValue) && numValue > 0 ? numValue : null;
        }

        function toNumber(value) {
            const numValue = Number.parseFloat(String(value));
            return Number.isFinite(numValue) ? Math.round(numValue * 10000) / 10000 : 0;
        }

        function formatDecimal(value) {
            const numValue = toNumber(value);
            return Number.isInteger(numValue) ? String(numValue) : numValue.toFixed(2).replace(/\.?0+$/, "");
        }

        function money(value) {
            return new Intl.NumberFormat(undefined, {
                style: "currency",
                currency: "USD",
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            }).format(toNumber(value));
        }

        function norm(value) {
            return String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
        }

        function normalizeTrackingLevel(value) {
            const normalized = norm(value || "UNIT");
            if (normalized === "PALLET" || normalized === "PALLETS") return "PALLET";
            if (normalized === "CASE" || normalized === "CASES") return "CASE";
            return "UNIT";
        }

        function trackingLabel(value) {
            const normalized = normalizeTrackingLevel(value);
            if (normalized === "PALLET") return "Pallets";
            if (normalized === "CASE") return "Cases";
            return "Units";
        }

        function formatTrackedQuantity(value, trackingLevel) {
            const normalized = normalizeTrackingLevel(trackingLevel);
            const noun = normalized === "PALLET" ? "pallet" : (normalized === "CASE" ? "case" : "unit");
            return `${num(value)} ${noun}${value === 1 ? "" : "s"}`;
        }

        function summarizeTrackedTotals(lines) {
            return lines.reduce((totals, line) => {
                totals[normalizeTrackingLevel(line?.trackingLevel)] += Number(line?.quantity) || 0;
                return totals;
            }, { UNIT: 0, CASE: 0, PALLET: 0 });
        }

        function formatTrackedSummary(totals) {
            const parts = [];
            if (totals.UNIT) parts.push(formatTrackedQuantity(totals.UNIT, "UNIT"));
            if (totals.CASE) parts.push(formatTrackedQuantity(totals.CASE, "CASE"));
            if (totals.PALLET) parts.push(formatTrackedQuantity(totals.PALLET, "PALLET"));
            return parts.join(" | ") || "0 qty";
        }

        function formatMeasure(value) {
            if (value == null) return "";
            const parsed = Number(value);
            if (!Number.isFinite(parsed)) return "";
            return parsed % 1 === 0 ? String(parsed) : parsed.toFixed(2).replace(/\.?0+$/, "");
        }

        function formatDimensions(length, width, height, prefix = "") {
            if (!(length && width && height)) return "";
            const dims = [formatMeasure(length), formatMeasure(width), formatMeasure(height)].join(" x ");
            return prefix ? `${prefix} ${dims}` : dims;
        }

        function formatItemMasterMeta(item) {
            const parts = [
                item.upc ? `UPC ${item.upc}` : "",
                item.description,
                item.imageUrl ? "Photo attached" : "",
                trackingLabel(item.trackingLevel),
                item.unitsPerCase ? `${num(item.unitsPerCase)} ea/case` : "",
                formatDimensions(item.eachLength, item.eachWidth, item.eachHeight, "Each"),
                formatDimensions(item.caseLength, item.caseWidth, item.caseHeight, "Case")
            ];
            return parts.filter(Boolean).join(" | ") || "Saved item master";
        }

        function getOwnerOptions() {
            const owners = new Set();
            (state.masters.owners || []).forEach((owner) => owners.add(norm(owner)));
            (state.masters.ownerRecords || []).forEach((owner) => owners.add(owner.name));
            state.masters.items.forEach((item) => owners.add(item.accountName));
            state.inventory.forEach((line) => owners.add(line.accountName));
            state.batch.forEach((line) => owners.add(line.accountName));
            return [...owners].filter(Boolean);
        }

        function findMasterItemsByCode(code, accountName = "") {
            const query = norm(code);
            const owner = norm(accountName);
            if (!query) return [];
            return state.masters.items.filter((item) => (!owner || item.accountName === owner) && (item.sku === query || item.upc === query));
        }

        function getMasterItemForLine(line) {
            return state.masters.items.find((item) => item.accountName === line.accountName && item.sku === line.sku) || null;
        }

        function getLineDescription(line) {
            return getMasterItemForLine(line)?.description || line.description || "";
        }

        function filterInventoryByOwner(ownerFilter = "") {
            const query = norm(ownerFilter);
            return sortedInventory().filter((line) => !query || line.accountName.includes(query));
        }

        function getScopedInventory(ownerFilter = "") {
            return filterInventoryByOwner(getScopedCompanyValue(ownerFilter));
        }

        function inventoryMatchesQuery(line, query) {
            if (!query) return true;
            const master = getMasterItemForLine(line);
            return line.accountName.includes(query)
                || line.location.includes(query)
                || line.sku.includes(query)
                || (line.upc || "").includes(query)
                || normalizeTrackingLevel(line.trackingLevel).includes(query)
                || norm(master?.description).includes(query);
        }

        function num(value) {
            return new Intl.NumberFormat().format(value || 0);
        }

        function formatDate(value) {
            try {
                return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
            } catch {
                return value || "";
            }
        }

        function makeId(prefix) {
            return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        }

        function fileStamp() {
            return new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+/, "");
        }

        function downloadBlob(content, filename, type) {
            const blob = new Blob([content], { type });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        }

        function esc(value) {
            return String(value)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
        }

        function attr(value) {
            return esc(value);
        }

        function csvCell(value) {
            const text = String(value ?? "");
            return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
        }

        function parseCsv(text) {
            const rows = [];
            let row = [];
            let value = "";
            let inQuotes = false;

            for (let index = 0; index < text.length; index += 1) {
                const char = text[index];
                const next = text[index + 1];

                if (inQuotes) {
                    if (char === `"` && next === `"`) {
                        value += `"`;
                        index += 1;
                    } else if (char === `"`) {
                        inQuotes = false;
                    } else {
                        value += char;
                    }
                    continue;
                }

                if (char === `"`) {
                    inQuotes = true;
                    continue;
                }

                if (char === ",") {
                    row.push(value.trim());
                    value = "";
                    continue;
                }

                if (char === "\n") {
                    row.push(value.trim());
                    if (row.some((cell) => cell !== "")) rows.push(row);
                    row = [];
                    value = "";
                    continue;
                }

                if (char !== "\r") {
                    value += char;
                }
            }

            row.push(value.trim());
            if (row.some((cell) => cell !== "")) rows.push(row);
            return rows;
        }

        function csvHeaderKey(value) {
            return norm(value).replace(/[^A-Z0-9]+/g, "");
        }

        function csvRecordValue(record, aliases) {
            for (const alias of aliases) {
                const value = record[alias];
                if (typeof value === "string" && value.trim()) return value.trim();
            }
            return "";
        }

        function mapLocationCsvRows(rows) {
            if (!rows.length) return [];
            const headers = rows[0].map(csvHeaderKey);
            const hasHeader = headers.some((value) => ["BIN", "LOCATION", "CODE", "BINLOCATION", "NOTE", "ZONE", "DESCRIPTION", "COMMENT"].includes(value));
            const bodyRows = hasHeader ? rows.slice(1) : rows;

            return bodyRows.map((cells) => {
                if (!hasHeader) {
                    return {
                        code: norm(cells[0]),
                        note: String(cells[1] || "").trim().replace(/\s+/g, " ")
                    };
                }

                const record = Object.fromEntries(headers.map((header, index) => [header, String(cells[index] || "").trim()]));
                return {
                    code: norm(csvRecordValue(record, ["BIN", "LOCATION", "CODE", "BINLOCATION"])),
                    note: String(csvRecordValue(record, ["NOTE", "ZONE", "DESCRIPTION", "COMMENT"])).trim().replace(/\s+/g, " ")
                };
            }).filter((row) => row.code);
        }

        function mapItemCsvRows(rows) {
            if (!rows.length) return [];
            const headers = rows[0].map(csvHeaderKey);
            const hasHeader = headers.some((value) => [
                "ACCOUNT",
                "ACCOUNTNAME",
                "OWNER",
                "OWNERNAME",
                "VENDOR",
                "VENDORNAME",
                "CUSTOMER",
                "CUSTOMERNAME",
                "VENDORCUSTOMER",
                "VENDORORCUSTOMER",
                "VENDORCUSTOMERNAME",
                "SKU",
                "UPC",
                "DESCRIPTION",
                "TRACKING",
                "TRACKINGLEVEL",
                "UNITSPERCASE",
                "CASEPACK",
                "PACK",
                "EACHLENGTH",
                "CASELENGTH"
            ].includes(value));
            const bodyRows = hasHeader ? rows.slice(1) : rows;

            return bodyRows.map((cells, index) => {
                const rowNumber = hasHeader ? index + 2 : index + 1;
                if (!cells.some((cell) => String(cell || "").trim())) return null;

                let accountName = "";
                let sku = "";
                let upc = "";
                let description = "";
                let imageUrl = "";
                let trackingLevel = "UNIT";
                let unitsPerCase = null;
                let eachLength = null;
                let eachWidth = null;
                let eachHeight = null;
                let caseLength = null;
                let caseWidth = null;
                let caseHeight = null;

                if (!hasHeader) {
                    accountName = String(cells[0] || "").trim();
                    sku = String(cells[1] || "").trim();
                    upc = String(cells[2] || "").trim();
                    description = String(cells[3] || "").trim();
                    imageUrl = String(cells[4] || "").trim();
                    trackingLevel = String(cells[5] || "UNIT").trim() || "UNIT";
                    unitsPerCase = toPositiveInt(cells[6]);
                    eachLength = toPositiveNumber(cells[7]);
                    eachWidth = toPositiveNumber(cells[8]);
                    eachHeight = toPositiveNumber(cells[9]);
                    caseLength = toPositiveNumber(cells[10]);
                    caseWidth = toPositiveNumber(cells[11]);
                    caseHeight = toPositiveNumber(cells[12]);
                } else {
                    const record = Object.fromEntries(headers.map((header, cellIndex) => [header, String(cells[cellIndex] || "").trim()]));
                    accountName = csvRecordValue(record, ["ACCOUNTNAME", "ACCOUNT", "OWNERNAME", "OWNER", "VENDORCUSTOMERNAME", "VENDORCUSTOMER", "VENDORORCUSTOMER", "VENDORNAME", "VENDOR", "CUSTOMERNAME", "CUSTOMER"]);
                    sku = csvRecordValue(record, ["SKU", "ITEMSKU", "PRODUCTSKU"]);
                    upc = csvRecordValue(record, ["UPC", "UPCCODE", "UPCNUMBER", "BARCODE"]);
                    description = csvRecordValue(record, ["DESCRIPTION", "DESC", "ITEMDESCRIPTION", "ITEMNAME", "NAME"]);
                    imageUrl = csvRecordValue(record, ["IMAGEURL", "IMAGE", "PHOTOURL", "PHOTO", "GOOGLEDRIVEURL", "DRIVEURL"]);
                    trackingLevel = csvRecordValue(record, ["TRACKING", "TRACKINGLEVEL", "LEVEL", "UOM"]) || "UNIT";
                    unitsPerCase = toPositiveInt(csvRecordValue(record, ["UNITSPERCASE", "CASEPACK", "PACK", "QTYPERCASE"]));
                    eachLength = toPositiveNumber(csvRecordValue(record, ["EACHLENGTH", "UNITLENGTH"]));
                    eachWidth = toPositiveNumber(csvRecordValue(record, ["EACHWIDTH", "UNITWIDTH"]));
                    eachHeight = toPositiveNumber(csvRecordValue(record, ["EACHHEIGHT", "UNITHEIGHT"]));
                    caseLength = toPositiveNumber(csvRecordValue(record, ["CASELENGTH", "OUTERLENGTH"]));
                    caseWidth = toPositiveNumber(csvRecordValue(record, ["CASEWIDTH", "OUTERWIDTH"]));
                    caseHeight = toPositiveNumber(csvRecordValue(record, ["CASEHEIGHT", "OUTERHEIGHT"]));
                }

                const normalizedAccountName = norm(accountName);
                const normalizedSku = norm(sku);
                if (!normalizedAccountName || !normalizedSku) {
                    throw new Error(`Row ${rowNumber} is missing Company or SKU.`);
                }

                return {
                    accountName: normalizedAccountName,
                    sku: normalizedSku,
                    upc: norm(upc),
                    description: String(description || "").trim().replace(/\s+/g, " "),
                    imageUrl: normalizeImageReference(imageUrl),
                    trackingLevel: normalizeTrackingLevel(trackingLevel),
                    unitsPerCase,
                    eachLength,
                    eachWidth,
                    eachHeight,
                    caseLength,
                    caseWidth,
                    caseHeight
                };
            }).filter(Boolean);
        }

        function reportTableMarkup(headers, rows) {
            if (!rows.length) {
                return "<p>No rows found for this report.</p>";
            }
            return `
                <table>
                    <thead>
                        <tr>${headers.map((header) => `<th>${esc(header)}</th>`).join("")}</tr>
                    </thead>
                    <tbody>
                        ${rows.map((row) => `
                            <tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>
                        `).join("")}
                    </tbody>
                </table>
            `;
        }
    
