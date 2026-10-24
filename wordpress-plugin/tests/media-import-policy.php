<?php
define('ABSPATH', '/tmp/');
require dirname(__DIR__) . '/pos-accounting-connector/includes/class-pos-media-import.php';
$blocked = array('http://127.0.0.1/a.jpg','http://10.0.0.1/a.jpg','http://169.254.169.254/a.jpg','http://100.64.0.1/a.jpg','https://[::1]/a.jpg','https://[::ffff:127.0.0.1]/a.jpg','https://host.local/a.jpg','https://user:pass@example.org/a.jpg','file:///a.jpg','https://example.org:444/a.jpg','http://2130706433/a.jpg','http://0177.0.0.1/a.jpg');
foreach ($blocked as $url) {
 try { POS_Connector_Media_Import::target($url, static function() {return array('8.8.8.8');}); throw new RuntimeException('NOT BLOCKED: '.$url); }
 catch (Exception $e) { if (strpos($e->getMessage(), 'NOT BLOCKED') === 0) throw $e; }
}
$result = POS_Connector_Media_Import::target('https://images.example.org/a.jpg', static function() {return array('8.8.8.8');});
if ($result !== array('images.example.org',443,'8.8.8.8')) throw new RuntimeException('bad public target');
try { POS_Connector_Media_Import::target('https://images.example.org/a.jpg', static function() {return array('8.8.8.8','10.0.0.1');}); throw new RuntimeException('mixed DNS accepted'); } catch (Exception $e) { if ($e->getMessage()==='mixed DNS accepted') throw $e; }
echo "14 URL/IP/DNS policy assertions passed\n";
