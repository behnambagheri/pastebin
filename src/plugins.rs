pub mod mermaid;
pub mod plugin;
pub mod prism;

use std::collections::HashMap;

pub fn new(plugins: Vec<Box<dyn plugin::Plugin>>) -> plugin::PluginManager {
    let base_static_resources = load_static_resources!(
    "/static/index.html" => "../static/index.html",
    "/static/custom.js" => "../static/custom.js",
    "/static/style.css" => "../static/style.css",
    "/static/favicon.ico" => "../static/favicon.ico",
    "/static/usage.txt" => "../static/usage.txt",
    // Behnam Bagheri Design System, vendored by scripts/sync-ds.sh.
    "/static/ds/mark.svg" => "../static/ds/mark.svg",
    "/static/ds/v1/tokens.css" => "../static/ds/v1/tokens.css",
    "/static/ds/v1/base.css" => "../static/ds/v1/base.css",
    "/static/ds/v1/components.css" => "../static/ds/v1/components.css",
    "/static/ds/v1/fonts/space-grotesk/SpaceGrotesk-latin.woff2" => "../static/ds/v1/fonts/space-grotesk/SpaceGrotesk-latin.woff2",
    "/static/ds/v1/fonts/space-grotesk/SpaceGrotesk-latin-ext.woff2" => "../static/ds/v1/fonts/space-grotesk/SpaceGrotesk-latin-ext.woff2",
    "/static/ds/v1/fonts/space-grotesk/SpaceGrotesk-vietnamese.woff2" => "../static/ds/v1/fonts/space-grotesk/SpaceGrotesk-vietnamese.woff2",
    "/static/ds/v1/fonts/vazirmatn/Vazirmatn-variable.woff2" => "../static/ds/v1/fonts/vazirmatn/Vazirmatn-variable.woff2"
    );

    // The design system loads before the site stylesheet.
    let base_css_imports = vec![
        "/static/ds/v1/tokens.css",
        "/static/ds/v1/base.css",
        "/static/ds/v1/components.css",
        "/static/style.css",
    ];

    let base_js_imports = vec!["/static/custom.js"];

    plugin::PluginManager::build()
        .plugins(plugins)
        .static_resources(base_static_resources)
        .css_imports(base_css_imports)
        .js_imports(base_js_imports)
        .finalize()
}
