<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');

$newsFile = __DIR__ . '/news.json';

if (file_exists($newsFile)) {
    echo file_get_contents($newsFile);
} else {
    http_response_code(404);
    echo json_encode(['error' => 'Configuration file not found']);
}
?>