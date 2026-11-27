<?php
// Serveur de fichiers PatateLand : routes lues par le launcher.
//
//   GET /                        état du service (vérification de santé)
//   GET /config                  data/config.json
//   GET /articles                data/news.json
//   GET /files                   instances (data/instances.json), avec l'URL de leur manifest
//   GET /manifest/<nom>.json     fichiers d'une instance : chemin, SHA-1, taille, URL
//   GET /files/<nom>/<chemin>    fichiers de jeu, servis directement par Apache (apache.conf)
//
// Dossiers (variables d'environnement, valeurs par défaut de l'image) :
//   PL_DATA_DIR   config.json, news.json, instances.json
//   PL_FILES_DIR  un dossier par instance, nommé comme dans instances.json
//   PL_CACHE_DIR  SHA-1 déjà calculés (recalculés si la taille ou la date change)
//   PL_PUBLIC_URL adresse publique (sinon déduite de la requête et du proxy)

declare(strict_types=1);

const DATA_FILES = ['config' => 'config.json', 'articles' => 'news.json', 'instances' => 'instances.json'];

$dataDir = rtrim(getenv('PL_DATA_DIR') ?: '/var/www/data', '/');
$filesDir = rtrim(getenv('PL_FILES_DIR') ?: '/var/www/files', '/');
$cacheDir = rtrim(getenv('PL_CACHE_DIR') ?: sys_get_temp_dir() . '/patateland', '/');

function send(int $status, $body): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-cache');
    echo is_string($body) ? $body : json_encode($body, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function fail(int $status, string $message): never {
    send($status, ['error' => $message]);
}

/// Fichier JSON des données, vérifié avant d'être servi : un fichier cassé
/// donne une erreur claire plutôt qu'une réponse que le launcher refuserait.
function readData(string $dir, string $name): array {
    $path = "$dir/$name";
    if (!is_file($path)) fail(500, "$name introuvable dans le dossier des données");
    $value = json_decode((string) file_get_contents($path), true);
    if (!is_array($value)) fail(500, "$name n'est pas un JSON valide : " . json_last_error_msg());
    return $value;
}

/// Adresse publique : PL_PUBLIC_URL, sinon le schéma transmis par le proxy
/// (Coolify reçoit le HTTPS et parle en HTTP à Apache) et l'hôte demandé.
function publicUrl(): string {
    $configured = getenv('PL_PUBLIC_URL');
    if ($configured) return rtrim($configured, '/');
    $proto = strtolower(trim(explode(',', $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '')[0]));
    if ($proto !== 'https' && $proto !== 'http') {
        $proto = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
    }
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    if (!preg_match('/^[A-Za-z0-9.-]+(:\d+)?$/', $host)) fail(400, 'hôte invalide');
    return "$proto://$host";
}

function encodePath(string $path): string {
    return implode('/', array_map('rawurlencode', explode('/', $path)));
}

/// Fichiers d'une instance (chemins relatifs, séparateur « / »). Les fichiers
/// et dossiers cachés (« .quelquechose ») sont ignorés.
function listFiles(string $root): array {
    $files = [];
    $it = new RecursiveIteratorIterator(
        new RecursiveCallbackFilterIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS),
            fn (SplFileInfo $f) => $f->getFilename()[0] !== '.'
        )
    );
    foreach ($it as $file) {
        if ($file->isFile()) $files[] = substr($file->getPathname(), strlen($root) + 1);
    }
    sort($files, SORT_STRING);
    return $files;
}

/// Manifest d'une instance. Le SHA-1 d'un fichier n'est recalculé que si sa
/// taille ou sa date de modification a changé depuis la dernière fois.
function manifest(string $name, string $root, string $cacheDir, string $base): array {
    $cacheFile = "$cacheDir/" . rawurlencode($name) . '.json';
    $cache = is_file($cacheFile) ? (json_decode((string) file_get_contents($cacheFile), true) ?: []) : [];
    $fresh = [];
    $out = [];
    foreach (listFiles($root) as $path) {
        $full = "$root/$path";
        $size = filesize($full);
        $mtime = filemtime($full);
        $hit = $cache[$path] ?? null;
        $hash = ($hit && $hit[0] === $size && $hit[1] === $mtime) ? $hit[2] : sha1_file($full);
        $fresh[$path] = [$size, $mtime, $hash];
        $out[] = [
            'path' => $path,
            'hash' => $hash,
            'size' => $size,
            'url' => "$base/files/" . rawurlencode($name) . '/' . encodePath($path),
        ];
    }
    if ($fresh !== $cache && (is_dir($cacheDir) || @mkdir($cacheDir, 0775, true))) {
        $tmp = "$cacheFile." . getmypid();
        if (@file_put_contents($tmp, json_encode($fresh)) !== false) @rename($tmp, $cacheFile);
    }
    return $out;
}

// ---------- Routes ----------

if (!in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['GET', 'HEAD'], true)) fail(405, 'méthode non autorisée');
$route = rawurldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');
$route = rtrim($route, '/') ?: '/';

if ($route === '/') {
    send(200, ['service' => 'PatateLand', 'routes' => ['/config', '/articles', '/files']]);
}

if ($route === '/config' || $route === '/articles') {
    send(200, readData($dataDir, DATA_FILES[ltrim($route, '/')]));
}

$instances = null;
$loadInstances = function () use (&$instances, $dataDir): array {
    return $instances ??= readData($dataDir, DATA_FILES['instances']);
};

if ($route === '/files' || $route === '/instances') {
    $base = publicUrl();
    $list = [];
    foreach ($loadInstances() as $name => $info) {
        if (!is_array($info)) fail(500, "instances.json : « $name » doit être un objet");
        $list[$name] = ['name' => $name, 'url' => "$base/manifest/" . rawurlencode((string) $name) . '.json'] + $info;
    }
    send(200, $list ?: new stdClass());
}

if (preg_match('#^/manifest/([^/]+)\.json$#', $route, $m)) {
    $name = $m[1];
    // Seules les instances déclarées : pas de chemin arbitraire.
    if (!array_key_exists($name, $loadInstances())) fail(404, "instance inconnue : $name");
    $root = "$filesDir/$name";
    // Dossier absent (stockage non monté…) : erreur, et surtout pas une liste
    // vide, qui ferait supprimer les mods des joueurs (verify: true).
    if (!is_dir($root)) fail(503, "fichiers de l'instance $name introuvables sur le serveur");
    send(200, manifest($name, $root, $cacheDir, publicUrl()));
}

fail(404, 'route inconnue');
