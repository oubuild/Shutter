# 固定的 OCR 模型下载源

以下可选模型文件仅在用户显式操作后下载，仅提供给 Apple Silicon 且
macOS 13.4 以上的设备，不包含在安装包内。每个文件必须匹配下方固定的
SHA-256 才能安装或被加载。

- 检测模型：`PP-OCRv6_det_small.onnx`
  - 主源：`https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx`
  - 备源：`https://hf-mirror.com/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv6/det/PP-OCRv6_det_small.onnx`
  - SHA-256：`090f04abcd9d9a7498bc4ebf677e4cb9bdce1fe4197ddb7e529f1ef44e1ff94f`
- 识别模型（PP-OCRv6）：`PP-OCRv6_rec_small.onnx`
  - 主源：`https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx`
  - 备源：`https://hf-mirror.com/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/onnx/PP-OCRv6/rec/PP-OCRv6_rec_small.onnx`
  - SHA-256：`6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884`
- 字典（PP-OCRv6）：`ppocrv6_dict.txt`
  - 主源：`https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt`
  - 备源：`https://hf-mirror.com/DjB314/RapidOCR/resolve/04e88d0483f0bfcdd0f29429594244c10bfc2867/v3.9.2/paddle/PP-OCRv6/rec/PP-OCRv6_rec_small/ppocrv6_dict.txt`
  - SHA-256：`b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d`

## Qota-OCR

Qota-OCR 复用上面的 PP-OCRv6 small 检测模型。URL 固定在提交
`b3e644a61b307b55d82839016576cbee03670d58`。

- 识别模型：`qota_ocr_rec.onnx`
  - 主源：`https://hf-mirror.com/atonlee/Qota-OCR/resolve/b3e644a61b307b55d82839016576cbee03670d58/onnx/model.onnx`
  - 备源：`https://huggingface.co/atonlee/Qota-OCR/resolve/b3e644a61b307b55d82839016576cbee03670d58/onnx/model.onnx`
  - SHA-256：`27ccd15d20a753652273a49e36b75530477687738dd503edce5f4e2b819a4d36`
- 字符配置：`qota_ocr_preprocessor_config.json`
  - 主源：`https://hf-mirror.com/atonlee/Qota-OCR/resolve/b3e644a61b307b55d82839016576cbee03670d58/preprocessor_config.json`
  - 备源：`https://huggingface.co/atonlee/Qota-OCR/resolve/b3e644a61b307b55d82839016576cbee03670d58/preprocessor_config.json`
  - SHA-256：`fffcd60e1d556f2529efeb026797bbea269951c0f633812852c2aa33aa42e460`

`qota_ocr_dict.txt` 由校验过的 `character_list` 在本地生成。Qota-OCR 以
Apache License 2.0 分发。PaddleOCR 模型同样以 Apache License 2.0 分发，
其 ONNX 形式按 RapidOCR 兼容的推理格式打包。

备源仅在主源失败时使用。任何下载产物都必须匹配上述固定的字节数与
SHA-256，才能替换既有模型文件或被应用加载。
