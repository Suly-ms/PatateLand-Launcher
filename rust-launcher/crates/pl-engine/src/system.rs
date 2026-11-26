//! Informations système (rapports de crash, recommandation de RAM).
//! Lues directement auprès de Windows, sans lancer de processus.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SystemInfo {
    pub os: String,
    pub cpu: String,
    pub cores: usize,
    pub ram_gb: f64,
    pub gpu: String,
}

pub fn collect() -> SystemInfo {
    SystemInfo {
        os: os_name(),
        cpu: cpu_name(),
        cores: std::thread::available_parallelism().map_or(0, |n| n.get()),
        ram_gb: (total_memory_bytes() as f64 / 1_073_741_824.0 * 10.0).round() / 10.0,
        gpu: gpu_name(),
    }
}

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::{
        Registry::{HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW},
        SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Valeur texte de `HKLM\<key>\<value>`.
    pub fn registry_string(key: &str, value: &str) -> Option<String> {
        let (key, value) = (wide(key), wide(value));
        let mut buf = vec![0u16; 512];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY: chaînes terminées par zéro, tampon de `size` octets.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != 0 {
            return None;
        }
        let len = (size as usize / 2).saturating_sub(1);
        let s = String::from_utf16_lossy(&buf[..len.min(buf.len())]).trim().to_owned();
        (!s.is_empty()).then_some(s)
    }

    fn memory_status() -> Option<MEMORYSTATUSEX> {
        // SAFETY: structure initialisée avec sa taille, comme l'exige l'API.
        unsafe {
            let mut status: MEMORYSTATUSEX = std::mem::zeroed();
            status.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
            (GlobalMemoryStatusEx(&mut status) != 0).then_some(status)
        }
    }

    pub fn total_memory_bytes() -> u64 {
        memory_status().map_or(0, |s| s.ullTotalPhys)
    }

    pub fn available_memory_bytes() -> u64 {
        memory_status().map_or(0, |s| s.ullAvailPhys)
    }
}

#[cfg(windows)]
pub use imp::{available_memory_bytes, total_memory_bytes};

#[cfg(not(windows))]
pub use unix::{available_memory_bytes, total_memory_bytes};

#[cfg(windows)]
fn os_name() -> String {
    const KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    let build: u32 = imp::registry_string(KEY, "CurrentBuild").and_then(|b| b.parse().ok()).unwrap_or(0);
    // ProductName indique encore « Windows 10 » sur Windows 11.
    let name = if build >= 22000 { "Windows 11" } else { "Windows 10" };
    let version = imp::registry_string(KEY, "DisplayVersion").unwrap_or_default();
    format!("{name} {version} (build {build})").replace("  ", " ")
}

#[cfg(windows)]
fn cpu_name() -> String {
    imp::registry_string(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString")
        .unwrap_or_else(|| "Inconnu".into())
}

#[cfg(windows)]
fn gpu_name() -> String {
    // Classe « Display adapters » : première carte qui n'est pas l'adaptateur de base.
    const CLASS: &str = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
    (0..8)
        .filter_map(|i| imp::registry_string(&format!(r"{CLASS}\{i:04}"), "DriverDesc"))
        .find(|d| !d.contains("Basic Display") && !d.contains("Basic Render"))
        .unwrap_or_else(|| "Inconnu".into())
}

#[cfg(not(windows))]
use unix::{cpu_name, gpu_name, os_name};

/// macOS et Linux : fichiers du système (/proc) ou petites commandes
/// standard (sysctl, vm_stat, sw_vers), sans dépendance supplémentaire.
// Compilé aussi dans les tests Windows, pour vérifier ce code sans Mac ni Linux.
#[cfg(any(test, not(windows)))]
#[cfg_attr(windows, allow(dead_code))]
mod unix {
    fn command(program: &str, args: &[&str]) -> Option<String> {
        let out = std::process::Command::new(program).args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
    }

    /// Valeur en Ko d'une ligne de /proc/meminfo (« MemTotal:  16314108 kB »).
    pub(super) fn meminfo_kb(text: &str, key: &str) -> Option<u64> {
        text.lines().find(|l| l.starts_with(key))?.split_whitespace().nth(1)?.parse().ok()
    }

    /// Mémoire libre d'après vm_stat (macOS) : pages libres, inactives et
    /// spéculatives, multipliées par la taille de page.
    pub(super) fn vm_stat_available(text: &str) -> Option<u64> {
        let page: u64 = text.lines().next()?.split("page size of ").nth(1)?.split_whitespace().next()?.parse().ok()?;
        let pages = |key: &str| -> u64 {
            text.lines()
                .find(|l| l.starts_with(key))
                .and_then(|l| l.split(':').nth(1))
                .and_then(|v| v.trim().trim_end_matches('.').parse().ok())
                .unwrap_or(0)
        };
        Some((pages("Pages free") + pages("Pages inactive") + pages("Pages speculative")) * page)
    }

    pub fn total_memory_bytes() -> u64 {
        if cfg!(target_os = "macos") {
            command("sysctl", &["-n", "hw.memsize"]).and_then(|v| v.parse().ok()).unwrap_or(0)
        } else {
            std::fs::read_to_string("/proc/meminfo").ok().and_then(|t| meminfo_kb(&t, "MemTotal:")).map_or(0, |kb| kb * 1024)
        }
    }

    pub fn available_memory_bytes() -> u64 {
        if cfg!(target_os = "macos") {
            command("vm_stat", &[]).and_then(|t| vm_stat_available(&t)).unwrap_or(0)
        } else {
            std::fs::read_to_string("/proc/meminfo").ok().and_then(|t| meminfo_kb(&t, "MemAvailable:")).map_or(0, |kb| kb * 1024)
        }
    }

    pub fn os_name() -> String {
        if cfg!(target_os = "macos") {
            return format!("macOS {}", command("sw_vers", &["-productVersion"]).unwrap_or_default()).trim().to_owned();
        }
        std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|t| t.lines().find(|l| l.starts_with("PRETTY_NAME=")).map(|l| l[12..].trim_matches('"').to_owned()))
            .unwrap_or_else(|| "Linux".into())
    }

    pub fn cpu_name() -> String {
        let name = if cfg!(target_os = "macos") {
            command("sysctl", &["-n", "machdep.cpu.brand_string"])
        } else {
            std::fs::read_to_string("/proc/cpuinfo")
                .ok()
                .and_then(|t| t.lines().find(|l| l.starts_with("model name")).and_then(|l| l.split(':').nth(1)).map(|v| v.trim().to_owned()))
        };
        name.filter(|n| !n.is_empty()).unwrap_or_else(|| "Inconnu".into())
    }

    pub fn gpu_name() -> String {
        "Inconnu".into()
    }
}

#[cfg(test)]
mod unix_tests {
    #[test]
    fn parses_system_outputs() {
        let meminfo = "MemTotal:       16314108 kB\nMemFree:  1 kB\nMemAvailable:    9000000 kB\n";
        assert_eq!(super::unix::meminfo_kb(meminfo, "MemTotal:"), Some(16314108));
        assert_eq!(super::unix::meminfo_kb(meminfo, "MemAvailable:"), Some(9000000));
        let vm = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:      1000.\nPages active:  5.\nPages inactive:  2000.\nPages speculative:  24.\n";
        assert_eq!(super::unix::vm_stat_available(vm), Some(3024 * 16384));
    }
}
