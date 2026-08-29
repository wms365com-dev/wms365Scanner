(function () {
    "use strict";

    const STORAGE_KEY = "wms365.language";
    const SUPPORTED = ["en", "fr", "es"];
    const LABELS = { en: "English", fr: "Français", es: "Español" };
    const translations = {
        fr: {
            "Customer Portal": "Portail client", "WMS365 Customer Portal": "Portail client WMS365",
            "Customer Login": "Connexion client", "Customer Access": "Accès client", "Warehouse Software": "Logiciel d'entrepôt",
            "Review inventory, enter sales orders, submit purchase orders, and track warehouse progress from one account-scoped portal.": "Consultez l'inventaire, saisissez des commandes, soumettez des commandes d'achat et suivez les opérations d'entrepôt dans un portail réservé à votre entreprise.",
            "Customer teams sign in here to review stock and release work.": "Les équipes clientes se connectent ici pour consulter le stock et libérer les commandes.",
            "Use your account-scoped WMS365 portal to review inventory, create sales orders, submit purchase orders, and export reports without seeing any other customer's data.": "Utilisez le portail WMS365 de votre entreprise pour consulter l'inventaire, créer des commandes, soumettre des commandes d'achat et exporter des rapports sans voir les données d'autres clients.",
            "Customer users sign in here to access the account-scoped WMS365 portal.": "Les utilisateurs clients se connectent ici pour accéder au portail WMS365 de leur entreprise.",
            "Review only the stock assigned to your account with exports and filters built into the portal.": "Consultez uniquement le stock attribué à votre entreprise grâce aux filtres et aux exportations du portail.",
            "Create draft orders, release them to the warehouse, and track released, picked, staged, and shipped counts.": "Créez des brouillons, libérez-les vers l'entrepôt et suivez les quantités libérées, prélevées, préparées et expédiées.",
            "Submit expected receipts with item and shipment details before the warehouse receives the freight.": "Soumettez les réceptions prévues avec les détails des articles et de l'expédition avant l'arrivée à l'entrepôt.",
            "Warehouse users should use the separate warehouse login page.": "Les utilisateurs de l'entrepôt doivent utiliser la page de connexion réservée à l'entrepôt.",
            "Enter your email address": "Entrez votre adresse courriel", "Enter your portal password": "Entrez votre mot de passe du portail",
            "Enter a strong new password": "Entrez un nouveau mot de passe sécurisé", "Enter the new password again": "Entrez de nouveau le mot de passe",
            "Email Address": "Adresse courriel", "Password": "Mot de passe",
            "Sign in": "Se connecter", "Forgot username": "Nom d'utilisateur oublié", "Forgot password": "Mot de passe oublié",
            "Recovery Email": "Courriel de récupération", "Warehouse Login": "Connexion entrepôt", "Support": "Assistance",
            "Choose a New Password": "Choisir un nouveau mot de passe", "New Password": "Nouveau mot de passe",
            "Confirm New Password": "Confirmer le nouveau mot de passe", "Reset Password": "Réinitialiser le mot de passe",
            "Inventory": "Inventaire", "Inventory Visibility": "Visibilité de l'inventaire", "Order Entry": "Saisie de commandes",
            "Purchase Orders": "Commandes d'achat", "Sales Orders": "Commandes clients", "My Sales Orders": "Mes commandes clients",
            "My Purchase Orders": "Mes commandes d'achat", "New Sales Order": "Nouvelle commande client",
            "New Purchase Order": "Nouvelle commande d'achat", "Create Sales Order": "Créer une commande client",
            "Create Purchase Order": "Créer une commande d'achat", "Save Draft": "Enregistrer le brouillon",
            "Release Order": "Libérer la commande", "Add Line": "Ajouter une ligne", "Remove": "Supprimer",
            "Search": "Rechercher", "Search Items": "Rechercher des articles", "Select items...": "Sélectionner des articles...",
            "Add Selected Items": "Ajouter les articles sélectionnés", "Clear": "Effacer", "Refresh": "Actualiser",
            "Download": "Télécharger", "Preview": "Aperçu", "Print": "Imprimer", "Upload": "Téléverser",
            "Documents": "Documents", "Status": "Statut", "Actions": "Actions", "Quantity": "Quantité",
            "Available": "Disponible", "Ordered": "Commandé", "Shipped": "Expédié", "Released": "Libéré",
            "Picked": "Prélevé", "Staged": "Préparé", "Draft": "Brouillon", "Cancelled": "Annulé",
            "Company": "Entreprise", "Customer": "Client", "Customers": "Clients", "Items": "Articles",
            "Locations": "Emplacements", "Reports & Counts": "Rapports et comptages", "Finance": "Finances",
            "Purchasing": "Achats", "Sales": "Ventes", "Settings": "Paramètres", "Help": "Aide",
            "Notifications": "Notifications", "Available Companies": "Entreprises disponibles", "Quick links": "Liens rapides",
            "Warehouse Central": "Centre d'entrepôt", "WMS365 Warehouse Central": "Centre d'entrepôt WMS365",
            "Home": "Accueil", "Find": "Rechercher", "All": "Tous", "More options": "Plus d'options",
            "Open document": "Ouvrir le document", "Requested Ship Date": "Date d'expédition demandée",
            "Expected Ready": "Prêt prévu", "Shipped Date": "Date d'expédition", "Order Notes": "Notes de commande",
            "Contact Name": "Nom du contact", "Contact Tel": "Téléphone du contact", "Ship To": "Expédier à",
            "Ship To Phone": "Téléphone du destinataire", "Address 1": "Adresse 1", "Address 2": "Adresse 2",
            "City": "Ville", "State / Province": "État / Province", "Postal Code": "Code postal", "Country": "Pays",
            "Carrier": "Transporteur", "Tracking Number": "Numéro de suivi", "Shipment Type": "Type d'expédition",
            "Parcel": "Colis", "Customer Pickup": "Ramassage par le client", "Submit": "Soumettre",
            "Close": "Fermer", "Back": "Retour", "Continue": "Continuer", "Confirm": "Confirmer",
            "Cancel": "Annuler", "Language": "Langue", "Report Issue": "Signaler un problème",
            "Contact Support": "Contacter l'assistance", "Loading...": "Chargement...",
            "No records found.": "Aucun résultat trouvé.", "Select a company": "Sélectionner une entreprise",
            "Choose a SKU": "Choisir un UGS", "Required": "Obligatoire", "Optional": "Facultatif"
        },
        es: {
            "Customer Portal": "Portal del cliente", "WMS365 Customer Portal": "Portal del cliente WMS365",
            "Customer Login": "Inicio de sesión del cliente", "Customer Access": "Acceso del cliente", "Warehouse Software": "Software de almacén",
            "Review inventory, enter sales orders, submit purchase orders, and track warehouse progress from one account-scoped portal.": "Revise el inventario, ingrese pedidos de venta, envíe órdenes de compra y siga el progreso del almacén desde un portal exclusivo para su empresa.",
            "Customer teams sign in here to review stock and release work.": "Los equipos de clientes inician sesión aquí para revisar existencias y liberar pedidos.",
            "Use your account-scoped WMS365 portal to review inventory, create sales orders, submit purchase orders, and export reports without seeing any other customer's data.": "Use el portal WMS365 de su empresa para revisar inventario, crear pedidos, enviar órdenes de compra y exportar informes sin ver datos de otros clientes.",
            "Customer users sign in here to access the account-scoped WMS365 portal.": "Los usuarios clientes inician sesión aquí para acceder al portal WMS365 de su empresa.",
            "Review only the stock assigned to your account with exports and filters built into the portal.": "Revise únicamente las existencias asignadas a su empresa con los filtros y exportaciones del portal.",
            "Create draft orders, release them to the warehouse, and track released, picked, staged, and shipped counts.": "Cree borradores, libérelos al almacén y siga las cantidades liberadas, recogidas, preparadas y enviadas.",
            "Submit expected receipts with item and shipment details before the warehouse receives the freight.": "Envíe las recepciones previstas con los datos de artículos y envío antes de que la carga llegue al almacén.",
            "Warehouse users should use the separate warehouse login page.": "Los usuarios del almacén deben usar la página de acceso separada para el almacén.",
            "Enter your email address": "Ingrese su correo electrónico", "Enter your portal password": "Ingrese su contraseña del portal",
            "Enter a strong new password": "Ingrese una nueva contraseña segura", "Enter the new password again": "Ingrese nuevamente la contraseña",
            "Email Address": "Correo electrónico", "Password": "Contraseña",
            "Sign in": "Iniciar sesión", "Forgot username": "Olvidé mi usuario", "Forgot password": "Olvidé mi contraseña",
            "Recovery Email": "Correo de recuperación", "Warehouse Login": "Acceso del almacén", "Support": "Soporte",
            "Choose a New Password": "Elegir una nueva contraseña", "New Password": "Nueva contraseña",
            "Confirm New Password": "Confirmar nueva contraseña", "Reset Password": "Restablecer contraseña",
            "Inventory": "Inventario", "Inventory Visibility": "Visibilidad del inventario", "Order Entry": "Ingreso de pedidos",
            "Purchase Orders": "Órdenes de compra", "Sales Orders": "Pedidos de venta", "My Sales Orders": "Mis pedidos de venta",
            "My Purchase Orders": "Mis órdenes de compra", "New Sales Order": "Nuevo pedido de venta",
            "New Purchase Order": "Nueva orden de compra", "Create Sales Order": "Crear pedido de venta",
            "Create Purchase Order": "Crear orden de compra", "Save Draft": "Guardar borrador", "Release Order": "Liberar pedido",
            "Add Line": "Agregar línea", "Remove": "Eliminar", "Search": "Buscar", "Search Items": "Buscar artículos",
            "Select items...": "Seleccionar artículos...", "Add Selected Items": "Agregar artículos seleccionados",
            "Clear": "Limpiar", "Refresh": "Actualizar", "Download": "Descargar", "Preview": "Vista previa",
            "Print": "Imprimir", "Upload": "Cargar", "Documents": "Documentos", "Status": "Estado", "Actions": "Acciones",
            "Quantity": "Cantidad", "Available": "Disponible", "Ordered": "Pedido", "Shipped": "Enviado",
            "Released": "Liberado", "Picked": "Recogido", "Staged": "Preparado", "Draft": "Borrador",
            "Cancelled": "Cancelado", "Company": "Empresa", "Customer": "Cliente", "Customers": "Clientes",
            "Items": "Artículos", "Locations": "Ubicaciones", "Reports & Counts": "Informes y conteos",
            "Finance": "Finanzas", "Purchasing": "Compras", "Sales": "Ventas", "Settings": "Configuración",
            "Help": "Ayuda", "Notifications": "Notificaciones", "Available Companies": "Empresas disponibles",
            "Quick links": "Accesos rápidos", "Warehouse Central": "Centro de almacén",
            "WMS365 Warehouse Central": "Centro de almacén WMS365", "Home": "Inicio", "Find": "Buscar",
            "All": "Todos", "More options": "Más opciones", "Open document": "Abrir documento",
            "Requested Ship Date": "Fecha de envío solicitada", "Expected Ready": "Preparación prevista",
            "Shipped Date": "Fecha de envío", "Order Notes": "Notas del pedido", "Contact Name": "Nombre del contacto",
            "Contact Tel": "Teléfono del contacto", "Ship To": "Enviar a", "Ship To Phone": "Teléfono del destinatario",
            "Address 1": "Dirección 1", "Address 2": "Dirección 2", "City": "Ciudad",
            "State / Province": "Estado / Provincia", "Postal Code": "Código postal", "Country": "País",
            "Carrier": "Transportista", "Tracking Number": "Número de seguimiento", "Shipment Type": "Tipo de envío",
            "Parcel": "Paquetería", "Customer Pickup": "Recogida del cliente", "Submit": "Enviar",
            "Close": "Cerrar", "Back": "Volver", "Continue": "Continuar", "Confirm": "Confirmar",
            "Cancel": "Cancelar", "Language": "Idioma", "Report Issue": "Informar un problema",
            "Contact Support": "Contactar soporte", "Loading...": "Cargando...",
            "No records found.": "No se encontraron registros.", "Select a company": "Seleccionar una empresa",
            "Choose a SKU": "Elegir un SKU", "Required": "Obligatorio", "Optional": "Opcional"
        }
    };

    const originalText = new WeakMap();
    const originalAttributes = new WeakMap();
    let currentLanguage = "en";
    let translating = false;

    function normalizeLanguage(value) {
        const language = String(value || "").trim().toLowerCase().split("-")[0];
        return SUPPORTED.includes(language) ? language : "en";
    }

    function translatedText(value, language = currentLanguage) {
        const source = String(value || "");
        return language === "en" ? source : (translations[language]?.[source] || source);
    }

    function translateTextNode(node) {
        if (!node || node.nodeType !== Node.TEXT_NODE) return;
        const parent = node.parentElement;
        if (!parent || ["SCRIPT", "STYLE", "TEXTAREA"].includes(parent.tagName)) return;
        if (!originalText.has(node)) originalText.set(node, node.nodeValue);
        const source = originalText.get(node) || "";
        const core = source.trim();
        if (!core) return;
        const leading = source.match(/^\s*/)?.[0] || "";
        const trailing = source.match(/\s*$/)?.[0] || "";
        const next = `${leading}${translatedText(core)}${trailing}`;
        if (node.nodeValue !== next) node.nodeValue = next;
    }

    function translateAttribute(element, attribute) {
        if (!element.hasAttribute(attribute)) return;
        if (!originalAttributes.has(element)) originalAttributes.set(element, {});
        const originals = originalAttributes.get(element);
        if (!(attribute in originals)) originals[attribute] = element.getAttribute(attribute) || "";
        const next = translatedText(originals[attribute]);
        if (element.getAttribute(attribute) !== next) element.setAttribute(attribute, next);
    }

    function translateElement(root) {
        if (!root) return;
        if (root.nodeType === Node.TEXT_NODE) return translateTextNode(root);
        if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
        const elements = root.nodeType === Node.ELEMENT_NODE ? [root, ...root.querySelectorAll("*")] : [...root.querySelectorAll("*")];
        for (const element of elements) {
            if (element.dataset?.i18nIgnore === "true") continue;
            for (const child of element.childNodes) if (child.nodeType === Node.TEXT_NODE) translateTextNode(child);
            for (const attribute of ["placeholder", "title", "aria-label"]) translateAttribute(element, attribute);
        }
    }

    function addLanguageControl() {
        if (document.querySelector(".wms365-language-control")) return;
        const hosts = [...document.querySelectorAll("[data-language-control-host]")];
        if (!hosts.length) hosts.push(document.body);
        hosts.forEach((host) => {
            const wrapper = document.createElement("div");
            wrapper.className = "wms365-language-control";
            wrapper.dataset.i18nIgnore = "true";
            if (host === document.body) wrapper.classList.add("is-fallback");
            wrapper.innerHTML = `<button class="wms365-language-button" type="button" aria-label="Language" aria-haspopup="menu" aria-expanded="false" title="Language"><span class="wms365-language-button-label">${currentLanguage.toUpperCase()}</span><span class="wms365-language-chevron" aria-hidden="true"></span></button><div class="wms365-language-menu" role="menu" hidden>${SUPPORTED.map((language) => `<button type="button" role="menuitemradio" aria-checked="${language === currentLanguage}" data-language="${language}"><span>${LABELS[language]}</span><span class="wms365-language-code">${language.toUpperCase()}</span></button>`).join("")}</div>`;
            host.appendChild(wrapper);
            const button = wrapper.querySelector(".wms365-language-button");
            const menu = wrapper.querySelector(".wms365-language-menu");
            const closeMenu = () => {
                menu.hidden = true;
                button.setAttribute("aria-expanded", "false");
            };
            button.addEventListener("click", () => {
                const willOpen = menu.hidden;
                document.querySelectorAll(".wms365-language-menu").forEach((otherMenu) => { otherMenu.hidden = true; });
                document.querySelectorAll(".wms365-language-button").forEach((otherButton) => { otherButton.setAttribute("aria-expanded", "false"); });
                menu.hidden = !willOpen;
                button.setAttribute("aria-expanded", String(willOpen));
                if (willOpen) menu.querySelector('[aria-checked="true"]')?.focus();
            });
            menu.addEventListener("click", (event) => {
                const option = event.target.closest("[data-language]");
                if (!option) return;
                setLanguage(option.dataset.language);
                closeMenu();
                button.focus();
            });
            document.addEventListener("click", (event) => {
                if (!wrapper.contains(event.target)) closeMenu();
            });
            document.addEventListener("keydown", (event) => {
                if (event.key === "Escape" && !menu.hidden) {
                    closeMenu();
                    button.focus();
                }
            });
        });
    }

    function updateLanguageControl() {
        document.querySelectorAll(".wms365-language-button").forEach((button) => {
            button.setAttribute("aria-label", translatedText("Language"));
            button.title = translatedText("Language");
        });
        document.querySelectorAll(".wms365-language-button-label").forEach((label) => { label.textContent = currentLanguage.toUpperCase(); });
        document.querySelectorAll(".wms365-language-menu [data-language]").forEach((option) => {
            option.setAttribute("aria-checked", String(option.dataset.language === currentLanguage));
        });
    }

    function setLanguage(language) {
        currentLanguage = normalizeLanguage(language);
        localStorage.setItem(STORAGE_KEY, currentLanguage);
        document.documentElement.lang = currentLanguage;
        translating = true;
        translateElement(document);
        updateLanguageControl();
        translating = false;
        window.dispatchEvent(new CustomEvent("wms365:languagechange", { detail: { language: currentLanguage } }));
    }

    function start() {
        currentLanguage = normalizeLanguage(localStorage.getItem(STORAGE_KEY) || navigator.language || "en");
        const style = document.createElement("style");
        style.textContent = `.wms365-language-control{position:relative;display:inline-flex;flex:0 0 auto;color:#20303a;font:700 12px/1 system-ui,-apple-system,"Segoe UI",sans-serif}.wms365-language-button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-width:44px;height:32px;padding:0 10px;border:1px solid #c9d5de;border-radius:5px;background:#fff;color:#264257;font:inherit;letter-spacing:0;cursor:pointer}.wms365-language-button:hover,.wms365-language-button:focus-visible,.wms365-language-button[aria-expanded="true"]{border-color:#5f8197;background:#eef4f8;outline:none}.wms365-language-chevron{width:6px;height:6px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg) translateY(-1px)}.wms365-language-menu{position:absolute;top:calc(100% + 6px);right:0;z-index:10020;width:190px;padding:5px;border:1px solid #cbd6df;border-radius:6px;background:#fff;box-shadow:0 10px 28px rgba(26,43,55,.18)}.wms365-language-menu[hidden]{display:none}.wms365-language-menu button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:38px;padding:7px 9px;border:0;border-radius:4px;background:transparent;color:#20303a;font:600 13px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0;text-align:left;cursor:pointer}.wms365-language-menu button:hover,.wms365-language-menu button:focus-visible{background:#eef4f8;outline:none}.wms365-language-menu button[aria-checked="true"]{background:#e4f1f8;color:#07577b}.wms365-language-code{color:#6b7f8f;font-size:11px}.wms365-language-control.is-fallback{position:fixed;top:8px;right:10px;z-index:10020}`;
        document.head.appendChild(style);
        addLanguageControl();
        setLanguage(currentLanguage);
        new MutationObserver((mutations) => {
            if (translating) return;
            translating = true;
            for (const mutation of mutations) for (const node of mutation.addedNodes) translateElement(node);
            translating = false;
        }).observe(document.body, { childList: true, subtree: true });
    }

    window.WMS365_I18N = {
        get language() { return currentLanguage; },
        setLanguage,
        t: translatedText,
        supportedLanguages: [...SUPPORTED]
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
})();
