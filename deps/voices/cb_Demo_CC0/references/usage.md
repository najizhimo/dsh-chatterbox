# 用法（Demo_CC0_ja）

```powershell
> 占位符：`<插件>` = 插件根目录；`<Irodori venv>` = 依赖页「合成用 Python」指向的那个 venv。
> 语音约定里会给出本机的真实路径，照着替换即可。

$py  = "<Irodori venv>\Scripts\python.exe"
$say = "<插件>\src\tts\speak.py"
& $py $say -t "おはようございます。" --profile Demo_CC0_ja
```

| 参数 | 作用 |
|---|---|
| `--profile` | 必带，`Demo_CC0_ja` |
| `--no-play` | 只生成不播放 |
| `--sync` | 等播放完再返回 |
| `--name` | 指定输出名（`out\<name>.wav`） |
| `--smile` | 句尾加 ♪ |
| `--caption` | 风格描述（日文，影响弱） |
| `--breaths "1,3"` | 只在第 1、3 句后换气 |
| `--raw` | 跳过停顿处理 |

产物落在 `dsh-chatterbox\out\`，按「音频保留天数」自动清理（`keep_` 除外）。
