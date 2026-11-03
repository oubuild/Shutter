# Shutter 本地 OCR 模型说明

「提取文字」默认使用 macOS 系统识别（Vision 框架），无需下载任何文件。
Apple Silicon 且 macOS 13.4 以上的设备可以显式下载并选择 PP-OCRv6 small 或
Qota-OCR 本地模型；其它设备仅显示云端识别与系统识别。上次选择的引擎会
持久化保存。模型文件存放在应用本地数据目录
（`~/Library/Application Support/Shutter/ocr-models`），不随安装包分发，
切换识别方式不会删除已下载的模型。

下载完成后应存在的文件：

- `PP-OCRv6_det_small.onnx`
- `PP-OCRv6_rec_small.onnx`
- `ppocrv6_dict.txt`
- `qota_ocr_rec.onnx`
- `qota_ocr_preprocessor_config.json`
- `qota_ocr_dict.txt`（由校验过的 preprocessor config 在本地生成）

模型产物源自 PaddleOCR/RapidOCR 与 Qota-OCR，以 Apache License 2.0 分发。
只有字节数与 SHA-256 校验和都匹配 `MODEL-SOURCES.md` 的文件才会被接受安装。
