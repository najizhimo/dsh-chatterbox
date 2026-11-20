# 音色档案：Demo_CC0_ja（公開デモ音声・パブリックドメイン）

把日语文本交给本机常驻 TTS，用**这个档案的音色**合成并播放。只做「念出来」这一件事，不改写、不做后期。

- 档案 ID：`Demo_CC0_ja`
- 参考音来源：LibriVox 公开领域录音《眼鏡》（島崎藤村），item `megane_1407_librivox`
- 许可：Public Domain Mark 1.0 —— **参考音可随档案一起公开分发**
- 参考音：`samples\Demo_CC0_ja_sample.wav`（30.00 秒 / 44.1 kHz / 单声道）
- 参数与禁则：同目录 `MODEL_CARD.md`

> 本目录就是「音色档案」本身：说明、参考音、文档都在这里，由 `dsh-chatterbox` 插件选中后使用。
> 它不是 DSH 技能——**用 read 工具读本文件**，不要等 `skill` 工具。

## 触发

主人说「念出来」「念一下」「读一下」「用这个演示音色」，或要试听本机 TTS 时，按本档案流程合成并播放。

主人点名的是**另一个档案**（其它 `cb_*` 目录）时，改用那个档案，本档案不要抢。

## 调用

```powershell
> 占位符：`<插件>` = 插件根目录；`<Irodori venv>` = 依赖页「合成用 Python」指向的那个 venv。
> 语音约定里会给出本机的真实路径，照着替换即可。

$py  = "<Irodori venv>\Scripts\python.exe"
$say = "<插件>\src\tts\speak.py"
$P   = "Demo_CC0_ja"

& $py $say -t "読む文" --profile $P                    # 生成并播放
& $py $say -t "文" --profile $P --no-play              # 只生成不播
& $py $say -t "文" --profile $P --sync                 # 等播完再返回
& $py $say -t "文" --profile $P --name clip1           # 指定输出名
& $py $say -t "文" --profile $P --keep                 # 长期保留（keep_ 前缀）
& $py $say -t "文" --profile $P --smile                # 句尾加 ♪（更亮、带笑）
& $py $say -t "文" --profile $P --caption "落ち着いた朗読調の声"   # 风格描述（日文）
& $py $say -t "文" --profile $P --breaths "1,3"        # 指定句号后换气
& $py $say -t "文" --profile $P --raw                  # 跳过停顿处理
& $py $say --list                                      # 列出档案（* 为默认）
& $py $say --status                                    # 服务状态
```

`--profile $P` **建议每次都带**：配置页里选中的是哪个档案，不带 `--profile` 时服务就用它的默认值——所以建议每次都带。

## 念什么

- 日语原文照念，一字不改；
- 单段不超过 30 秒（服务端上限），更长的文本客户端自动切块；
- 语气调味只有两种：句尾 `♪`（`--smile`）与 `--caption`（影响很弱）。

## 边界

- 不改写、不翻译、不做后期（变调／变速／均衡一律禁止）；
- 音色由**参考音**决定：换参考音才换音色，训练与微调都不做；
- 参考音是公有领域录音，可以公开分发；**但不要**把它和其它角色的商用素材混在同一包里分发。

## 汇报

一行说清：`profile=Demo_CC0_ja · audio_s=… · gen_s=…`，再加音频链接与重放链接。
