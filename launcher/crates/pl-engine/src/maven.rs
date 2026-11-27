use anyhow::{Result, bail};

/// `groupe:artefact:version[:classifier][@ext]` -> chemin relatif dans un dépôt Maven.
pub fn path(coord: &str) -> Result<String> {
    let (coord, ext) = coord.split_once('@').unwrap_or((coord, "jar"));
    let parts: Vec<&str> = coord.split(':').collect();
    if parts.len() < 3 {
        bail!("coordonnée Maven invalide : {coord}");
    }
    let group = parts[0].replace('.', "/");
    let (artifact, version) = (parts[1], parts[2]);
    let file = match parts.get(3) {
        Some(classifier) => format!("{artifact}-{version}-{classifier}.{ext}"),
        None => format!("{artifact}-{version}.{ext}"),
    };
    Ok(format!("{group}/{artifact}/{version}/{file}"))
}

/// Clé de dédoublonnage du classpath : `groupe:artefact[:classifier]`, sans
/// la version, pour que la version imposée par Forge l'emporte sur celle de
/// Minecraft.
pub fn dedup_key(coord: &str) -> String {
    let coord = coord.split('@').next().unwrap_or(coord);
    let parts: Vec<&str> = coord.split(':').collect();
    match parts.as_slice() {
        [group, artifact, _, classifier, ..] => format!("{group}:{artifact}:{classifier}"),
        [group, artifact, ..] => format!("{group}:{artifact}"),
        _ => coord.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maven_paths() {
        assert_eq!(
            path("org.lwjgl:lwjgl:3.3.1:natives-windows").unwrap(),
            "org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar"
        );
        assert_eq!(
            path("de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412:mappings@txt").unwrap(),
            "de/oceanlabs/mcp/mcp_config/1.20.1-20230612.114412/mcp_config-1.20.1-20230612.114412-mappings.txt"
        );
        assert_eq!(dedup_key("org.ow2.asm:asm:9.5"), "org.ow2.asm:asm");
        assert_eq!(dedup_key("org.lwjgl:lwjgl:3.3.1:natives-windows"), "org.lwjgl:lwjgl:natives-windows");
    }
}
