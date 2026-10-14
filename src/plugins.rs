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
    "/static/usage.txt" => "../static/usage.txt"
    );

    let base_css_imports = vec!["/static/style.css"];

    let base_js_imports = vec!["/static/custom.js"];

    plugin::PluginManager::build()
        .plugins(plugins)
        .static_resources(base_static_resources)
        .css_imports(base_css_imports)
        .js_imports(base_js_imports)
        .finalize()
}
