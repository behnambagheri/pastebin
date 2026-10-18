// ── Web Crypto helpers ────────────────────────────────────────────────────────
// Format: base64( salt[16] || iv[12] || ciphertext )
// Key derivation: PBKDF2-SHA256, 100 000 iterations → AES-256-GCM key.

async function cryptoEncrypt(plaintext, password) {
    var enc  = new TextEncoder();
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iv   = crypto.getRandomValues(new Uint8Array(12));

    var keyMaterial = await crypto.subtle.importKey(
        "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]
    );
    var key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: 1000000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false, ["encrypt"]
    );

    var ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv }, key, enc.encode(plaintext)
    );

    var result = new Uint8Array(16 + 12 + ciphertext.byteLength);
    result.set(salt, 0);
    result.set(iv, 16);
    result.set(new Uint8Array(ciphertext), 28);

    var binary = "";
    for (var i = 0; i < result.length; i++) { binary += String.fromCharCode(result[i]); }
    return btoa(binary);
}

async function cryptoDecrypt(ciphertextB64, password) {
    var enc  = new TextEncoder();
    var data = Uint8Array.from(atob(ciphertextB64), function(c) { return c.charCodeAt(0); });

    var salt       = data.slice(0, 16);
    var iv         = data.slice(16, 28);
    var ciphertext = data.slice(28);

    var keyMaterial = await crypto.subtle.importKey(
        "raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]
    );
    var key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: 1000000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false, ["decrypt"]
    );

    var plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv }, key, ciphertext
    );
    return new TextDecoder().decode(plaintext);
}
// ─────────────────────────────────────────────────────────────────────────────

(function () {
    "use strict";

    function byId(id) { return document.getElementById(id); }

    function withParams(path, params) {
        var query = Object.keys(params).map(function (key) {
            return encodeURIComponent(key) + "=" + encodeURIComponent(params[key]);
        }).join("&");
        return path + (path.indexOf("?") >= 0 ? "&" : "?") + query;
    }

    // ── Theme: follows the OS until the visitor picks light or dark ──────────
    // Same behavior and storage key ("bb-theme") as bea.sh and the design system.
    function initTheme() {
        var THEME_KEY = "bb-theme";
        var root = document.documentElement;
        var button = byId("themeButton");
        var system = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
        if (!button) return;

        function saved() {
            try {
                var theme = localStorage.getItem(THEME_KEY);
                return theme === "light" || theme === "dark" ? theme : null;
            } catch (e) {
                return null;
            }
        }
        var picked = saved();
        function current() { return picked || (system && system.matches ? "dark" : "light"); }

        function apply() {
            var theme = current();
            if (picked) root.setAttribute("data-theme", theme);
            else root.removeAttribute("data-theme");
            // The icon shows the theme on screen; clicking switches to the other one.
            var label = "Theme: " + theme + ". Switch to " + (theme === "dark" ? "light" : "dark");
            button.setAttribute("data-current", theme);
            button.setAttribute("aria-label", label);
            button.title = label;
        }

        button.addEventListener("click", function () {
            picked = current() === "dark" ? "light" : "dark";
            try {
                localStorage.setItem(THEME_KEY, picked);
            } catch (e) {
                // The theme still applies to this page when storage is unavailable.
            }
            apply();
        });
        if (system) system.addEventListener("change", apply);
        apply();
    }

    // Dialogs close when the backdrop outside them is clicked.
    function closeOnBackdrop(dialog) {
        dialog.addEventListener("click", function (event) {
            var box = dialog.getBoundingClientRect();
            var inside = event.clientX >= box.left && event.clientX <= box.right &&
                event.clientY >= box.top && event.clientY <= box.bottom;
            if (event.target === dialog && !inside) dialog.close();
        });
    }

    // Usage tabs: arrow keys move between tabs, like a native tab list.
    function initTabs(list) {
        var tabs = Array.prototype.slice.call(list.querySelectorAll("[role=tab]"));
        function select(tab) {
            tabs.forEach(function (other) {
                var selected = other === tab;
                other.setAttribute("aria-selected", String(selected));
                other.tabIndex = selected ? 0 : -1;
                byId(other.getAttribute("aria-controls")).hidden = !selected;
            });
        }
        tabs.forEach(function (tab, index) {
            tab.addEventListener("click", function () { select(tab); });
            tab.addEventListener("keydown", function (event) {
                var step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                if (!step) return;
                event.preventDefault();
                var next = tabs[(index + step + tabs.length) % tabs.length];
                select(next);
                next.focus();
            });
        });
    }

    // ── Usage dialog ─────────────────────────────────────────────────────────
    function initUsage() {
        var dialog = byId("usage-dialog");
        if (!dialog) return;

        var base = window.location.origin + uri_prefix;
        document.querySelectorAll("[data-usage-base]").forEach(function (node) {
            node.textContent = base;
        });

        document.querySelectorAll("[data-open-usage]").forEach(function (button) {
            button.addEventListener("click", function () { dialog.showModal(); });
        });
        if (window.location.hash === "#usage") dialog.showModal();
        closeOnBackdrop(dialog);
        dialog.querySelectorAll("[role=tablist]").forEach(initTabs);

        dialog.querySelectorAll("[data-copy-code]").forEach(function (button) {
            var label = button;
            button.addEventListener("click", function () {
                // Drop the "$ " prompts and sample output so copied commands run as-is.
                var lines = button.parentElement.querySelector("code").textContent.split("\n");
                var hasPrompt = lines.some(function (line) { return line.indexOf("$ ") === 0; });
                var code = !hasPrompt ? lines.join("\n") : lines.filter(function (line, index) {
                    return line.indexOf("$ ") === 0 || (index > 0 && /\\$/.test(lines[index - 1]));
                }).map(function (line) { return line.replace(/^\$ /, ""); }).join("\n");
                navigator.clipboard.writeText(code).then(function () {
                    label.textContent = "Copied!";
                }, function () {
                    label.textContent = "Failed";
                }).then(function () {
                    setTimeout(function () { label.textContent = "Copy"; }, 1200);
                });
            });
        });
    }

    function init() {
        initTheme();
        initUsage();

        var codeBlock = byId("pastebin-code-block");
        var textarea = byId("content-textarea");
        var languageSelector = byId("language-selector");
        var expirySelector = byId("expiry-selector");
        var burnSelector = byId("burn-selector");
        var sendButton = byId("send-btn");
        var sendStatus = byId("send-status");

        var noticeClose = byId("notice-close");
        if (noticeClose) {
            noticeClose.addEventListener("click", function () { byId("notice").remove(); });
        }

        // Copy the link of a freshly created paste.
        var copyUrlButton = byId("copy-url-btn");
        if (copyUrlButton) {
            var copyUrlLabel = copyUrlButton.querySelector("span");
            var noticeUrl = byId("notice-url");
            noticeUrl.addEventListener("focus", function () { noticeUrl.select(); });
            copyUrlButton.addEventListener("click", function () {
                navigator.clipboard.writeText(copyUrlButton.getAttribute("data-url")).then(function () {
                    copyUrlLabel.textContent = "Copied!";
                }, function () {
                    copyUrlLabel.textContent = "Copy failed";
                }).then(function () {
                    setTimeout(function () { copyUrlLabel.textContent = "Copy link"; }, 1200);
                });
            });
        }

        // Reflect the requested or detected language in the selector.
        var lang = new URL(document.location).searchParams.get("lang");
        if (lang == null && codeBlock) {
            lang = codeBlock.className.trim().split("-")[1];
        }
        if (lang != null && languageSelector) {
            languageSelector.value = lang;
        }

        if (expirySelector) {
            var expiryDefault = expirySelector.getAttribute("data-default");
            Array.prototype.forEach.call(expirySelector.options, function (option) {
                if (option.textContent === expiryDefault) option.selected = true;
            });
        }

        init_plugins();

        if (languageSelector) {
            languageSelector.addEventListener("change", function () {
                if (codeBlock) {
                    codeBlock.className = "language-" + languageSelector.value;
                    init_plugins();
                }
            });
        }

        // ── Copy ─────────────────────────────────────────────────────────────
        var copyButton = byId("copy-btn");
        if (copyButton) {
            copyButton.addEventListener("click", function () {
                navigator.clipboard.writeText(codeBlock.textContent).then(function () {
                    copyButton.textContent = "Copied!";
                    copyButton.disabled = true;
                    setTimeout(function () {
                        copyButton.textContent = "Copy";
                        copyButton.disabled = false;
                    }, 800);
                });
            });
        }

        // ── Remove ───────────────────────────────────────────────────────────
        var deletionModal = byId("deletion-modal");
        var removeButton = byId("remove-btn");
        if (removeButton && deletionModal) {
            closeOnBackdrop(deletionModal);
            removeButton.addEventListener("click", function () { deletionModal.showModal(); });
            byId("deletion-confirm-btn").addEventListener("click", function () {
                var confirmButton = this;
                confirmButton.disabled = true;
                fetch(window.location.pathname, { method: "DELETE" }).then(function (response) {
                    if (!response.ok) throw new Error(response.statusText);
                    window.location.href = withParams(uri_prefix + "/new", {
                        level: "info",
                        msg: "The paste has been successfully removed.",
                    });
                }).catch(function () {
                    confirmButton.disabled = false;
                    confirmButton.textContent = "Retry";
                });
            });
        }

        // ── Create ───────────────────────────────────────────────────────────
        function send() {
            if (!sendButton || sendButton.disabled) return;
            var data = textarea.value;
            if (data.length === 0) {
                sendStatus.textContent = "Nothing to paste yet.";
                textarea.focus();
                return;
            }

            var params = {
                lang: languageSelector.value,
                ttl: expirySelector.value,
                burn: burnSelector.value,
            };
            var pass = byId("pastebin-password").value;

            sendButton.disabled = true;
            sendStatus.textContent = pass.length > 0 ? "Encrypting…" : "Uploading…";

            var payload = pass.length > 0
                ? cryptoEncrypt(data, pass).then(function (encrypted) {
                    params.encrypted = true;
                    return encrypted;
                })
                : Promise.resolve(data);

            payload.then(function (body) {
                return fetch(withParams(uri_prefix === "" ? "/" : uri_prefix, params), {
                    method: "POST",
                    headers: { "Content-Type": "text/plain" },
                    body: body,
                });
            }).then(function (response) {
                return response.text().then(function (text) {
                    if (!response.ok) throw new Error(text || response.statusText);
                    window.location.href = withParams(uri_prefix + "/new", {
                        level: "success",
                        msg: "The paste has been successfully created:",
                        url: text.trim(),
                    });
                });
            }).catch(function (error) {
                sendButton.disabled = false;
                sendStatus.textContent = "Could not create the paste: " + error.message;
            });
        }

        if (sendButton) {
            sendButton.addEventListener("click", send);
            textarea.addEventListener("keydown", function (event) {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    send();
                }
            });
        }

        // ── Decrypt ──────────────────────────────────────────────────────────
        var passwordModal = byId("password-modal");
        if (passwordModal) {
            var modalAlert = byId("modal-alert");
            var modalPassword = byId("modal-password");
            closeOnBackdrop(passwordModal);
            passwordModal.showModal();
            modalPassword.focus();

            byId("modal-close-btn").addEventListener("click", function () { passwordModal.close(); });
            byId("password-form").addEventListener("submit", function (event) {
                event.preventDefault();
                var data = codeBlock ? codeBlock.textContent : textarea.value;

                cryptoDecrypt(data, modalPassword.value).then(function (decrypted) {
                    if (codeBlock) {
                        codeBlock.textContent = decrypted;
                        init_plugins();
                    } else {
                        textarea.value = decrypted;
                    }
                    modalAlert.hidden = true;
                    passwordModal.close();
                }).catch(function () {
                    modalAlert.hidden = false;
                    modalPassword.select();
                });
            });
        }
    }

    if (typeof document.addEventListener === "function") {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", init);
        } else {
            init();
        }
    }
})();
