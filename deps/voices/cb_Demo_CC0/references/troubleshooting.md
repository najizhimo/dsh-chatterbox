# 排障（Demo_CC0_ja）

| 现象 | 判据 | 处理 |
|---|---|---|
| `--list` 里没有它 | 文件夹名不以 `cb_` 开头，或缺 `voice.json.profile` | 修正后用 `speak.py --start` 重启服务 |
| 声音没变 | 没带 `--profile`，用了默认档案 | 加上 `--profile Demo_CC0_ja` |
| `ref` 找不到 | `voice.json.ref` 是相对本目录的 `samples/...` | 确认文件存在且名字一致 |
| 服务没起 | `--status` 连接失败 | `speak.py --start`（装载 12–17 秒） |
| 港口被占 | `/health` 能通但版本不对 | 杀掉 `tts_daemon` 进程后重新合成 |
