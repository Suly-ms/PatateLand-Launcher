<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$configFile = __DIR__ . '/config.json';

if (file_exists($configFile)) {
    echo file_get_contents($configFile);
} else {
    http_response_code(404);
    echo json_encode(['error' => 'Configuration file not found']);
}
?>