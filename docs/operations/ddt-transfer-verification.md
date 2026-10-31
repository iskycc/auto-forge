# DDT 表格、源平台、目标平台三方校验

脚本：[verify_ddt_transfer.py](../../scripts/operations/verify_ddt_transfer.py)。需要 Python 3.10 或更高版本，仅使用标准库，无需安装 pip 包、启动平台 worker 或访问公网。可在能够访问两个平台的电脑上运行，Lite 与 Full 使用同一套 API。

它校验的是 **DDT 用例原始字段**，输入为 DDT 管理导出的 XLSX／CSV，不是执行结果、失败分析清单或 TestNG 清单。用例的内部数据库 ID、修订号、修改时间和执行历史不作为跨平台字段比较对象；源、目标通常会有不同的内部 ID。SR 标签、执行类关联、任务成员等独立配置不在这个校验范围内。

## 必填信息

- 表格文件路径，可重复指定 `--file`，共同构成待验证清单。
- 源平台 DDT 开放 API 地址：包含项目、版本和测试阶段。
- 目标平台对应的 DDT 开放 API 地址：两个平台的范围 ID 可以不同。
- 默认全量模式还需要两边具有对应项目 `case.read` 权限的服务账号 API Key，分别放在环境变量中。仅有公开接口不能列出平台全部用例，无法发现“表格和目标同时少了同一个源用例”。

进入“用例管理 → DDT 管理 → 开放 API”，选择对应项目、版本和阶段，复制完整 API 地址。可直接提供范围地址，也支持粘贴该范围的单用例查询地址，脚本会提取范围，遍历全部 CaseID。

地址形如：

```text
http://源平台:3000/api/v1/public/ddt/projects/项目ID/versions/版本ID/stages/阶段ID
http://目标平台:3000/api/v1/public/ddt/projects/项目ID/versions/版本ID/stages/阶段ID
```

API Key 在服务账号管理中签发，使用现有项目授权，不需要写权限。令牌不写进命令行参数、报告或 URL。

## 运行

在仓库根目录执行；也可以把 Python 文件单独复制到校验电脑。

```bash
# 交互输入，不把实际令牌写入 Shell 历史。
read -rsp '源平台 API Key: ' AUTOFORGE_SOURCE_API_KEY
echo
export AUTOFORGE_SOURCE_API_KEY
read -rsp '目标平台 API Key: ' AUTOFORGE_TARGET_API_KEY
echo
export AUTOFORGE_TARGET_API_KEY

python3 -B scripts/operations/verify_ddt_transfer.py \
  --file '/path/to/DDT用例.xlsx' \
  --source-url 'http://192.168.1.10:3000/api/v1/public/ddt/projects/source-project/versions/source-version/stages/source-stage' \
  --target-url 'http://192.168.1.20:3000/api/v1/public/ddt/projects/target-project/versions/target-version/stages/target-stage' \
  --output-dir '/path/to/new-verification-report'

result=$?
unset AUTOFORGE_SOURCE_API_KEY AUTOFORGE_TARGET_API_KEY
echo "校验退出码：$result"
```

Windows 上将 `python3` 换成 `py -3`，路径使用本机文件路径；同样先设置上述两个环境变量。`--output-dir` 必须是尚不存在的新目录，避免覆盖旧校验结果；不指定时在当前目录生成唯一的 `ddt-verification-时间-随机后缀` 报告目录。

多个分组导出文件可以一起检查：

```bash
python3 -B scripts/operations/verify_ddt_transfer.py \
  --file '/path/to/Wallet.xlsx' \
  --file '/path/to/Payment.xlsx' \
  --source-url 'http://源平台:3000/api/v1/public/ddt/projects/P1/versions/V1/stages/S1' \
  --target-url 'http://目标平台:3000/api/v1/public/ddt/projects/P2/versions/V2/stages/S2'
```

重复的 CaseID 会报错，不会静默保留第一条。**默认检查整个测试阶段**，多个文件合计应覆盖该阶段；只导出几个 SR 而平台还存在其他用例时，会报告那些用例未包含在表格中。

## 如何判定一致

1. 流式读取 XLSX 实际单元格，用临时 SQLite 保存用例、旅程行和共享字符串索引，不把宽表空列展开到每条用例。读取 CSV 时保留文本类型、前导零和引号内换行。
2. 分页读取两边的完整 DDT 目录，每页 100 条。取“表格 ∪ 源平台 ∪ 目标平台”的 CaseID 并集，发现表格缺失、源平台缺失、目标平台缺失和多余用例。
3. 按 CaseID 查询两边的公开原始字段 API。使用查询参数编码，支持中文、空格、`/`、`?`、`#` 和 `%`，不会错误地把业务字段 `data` 当成响应包装层。
4. 逐字段比较“表格—源平台”“表格—目标平台”“源平台—目标平台”，用户旅程比较到具体 Step 和字段。忽略 JSON 字段顺序；字段名、大小写、非空字符串、数字／字符串／布尔类型和字段是否存在均参与比较，不擅自去空白或转换类型。CaseID 定位遵循平台的去首尾空白、不区分大小写规则，字段内容仍严格比较。
5. 最后再次遍历两个平台目录，对比 CaseID、记录 ID、修订号和修改时间；对输入文件重新计算 SHA-256。如果验证期间用例或表格发生变化，判为未完成，不能认证一致。验证前应暂停用例编辑、导入和清理，保持两个范围的数据稳定；本脚本不会锁住平台。

表格本身无法区分“字段不存在”“单元格为空字符串”和“原字段为 null”。默认仍严格检查：如果 API 保存了空字段而 XLSX 没有实际单元格，会报告字段存在性差异。需要明确按平台当前稀疏导入规则只验证有效数据时，额外指定：

```text
--ignore-empty
```

此选项仅让缺失、null、空串、仅空白字符互相等价；`0`、`false`、字符串 `"0"` 和 `"false"` 仍分别比较。被忽略的差异也完整写入报告并计数，结果标记为 `effective_data_match`，不会标为严格一致。默认不启用此选项。

XLSX 的 `data` 表及连续的 `step1…stepN` 用户旅程表可混合；保留导出的缺失 Step 标记，不凭空补齐旅程。附带的说明页不作为用例。重复表头、缺少 CaseID／srNum、重复 CaseID、旅程错行、损坏文件和公式单元格均停止校验，避免猜测数据。旧 XLS／XLSB／ODS 需先另存为平台标准 XLSX；脚本不计算公式或读取 Excel 的格式化显示值，数值按单元格真实类型比较。

## 报告与退出码

| 文件              | 内容                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `summary.json`    | 是否完成、三方数量、核对数量、不同用例数、差异数量、读取错误、目录与修订稳定性、输入文件 SHA-256 |
| `differences.csv` | CaseID、表格位置、比较双方、JSON Pointer 字段路径、是否忽略、左右类型与 SHA-256；不截断差异      |
| `errors.csv`      | 请求失败或无法完成校验的原因；503／超时不会被误判成用例不存在或一致                              |

默认差异报告不记录字段原值。需要逐项查看原文时加 `--include-values`，CSV 会增加左右两边完整 JSON 值，报告可能含用例中的敏感内容，应妥善保管。CSV 带 UTF-8 BOM 方便 Excel 打开，并对公式起始字符进行转义；JSON 为普通 UTF-8。在支持 POSIX 权限的系统中，报告目录为 `0700`，文件为 `0600`，临时索引在结束／中断后清理。

| 退出码 | 含义                                                                                         |
| ------ | -------------------------------------------------------------------------------------------- |
| `0`    | 指定范围核对完成，无未忽略差异；默认全量模式且未加 `--ignore-empty` 时，`result=exact_match` |
| `1`    | 核对完成，存在缺失／多余用例或字段差异                                                       |
| `2`    | 命令行参数语法无效                                                                           |
| `3`    | 未完成：文件无法解析、鉴权失败、请求重试耗尽、分页异常或校验期间数据变化等；修复原因后重试   |
| `130`  | 用户中断，不能据此判断一致                                                                   |

认证全量一致需同时满足：退出码 `0`、`complete=true`、`result=exact_match`、`inventoryVerified=true`、`stabilityVerified=true`、`readErrors=0`。仅比较数量、仅源目标相等、部分请求成功或只有文件范围通过，都不足以宣称全量三方一致。

## 可选参数与负载

- `--file-scope-only`：无需 API Key，仅匿名核对表格里列出的用例；摘要标明 `scope=spreadsheet_cases_only`，目录及稳定性检查为 false，无法发现平台额外用例，也不认证全量一致。
- `--requests-per-second 10`：调整**两边合计**的请求频率，默认 5，最大 100，始终串行，不启用并发请求。8000 条通常需要约 16000 次原始字段查询，另加前后分页目录读取；按平台负载适当调整。
- `--timeout 15 --retries 2`：单次请求超时与有限重试；只重试连接失败、429、502、503、504，不重试权限错误。对端长时间 Pending 会按超时结束，不无限等待。
- `--source-ca-file /path/source-ca.pem`、`--target-ca-file /path/target-ca.pem`：HTTPS 私有 CA 证书；始终验证证书，不提供跳过校验开关。
- `--source-token-env OTHER_SOURCE_KEY`、`--target-token-env OTHER_TARGET_KEY`：自定义 API Key 环境变量名。
- `--csv-encoding gb18030`：旧 CSV 指定编码，默认 `utf-8-sig`。CSV 缺乏数值／布尔类型信息，严格模式会报告与 API 真实类型的差别，不自动转换。
- `--max-uncompressed-mib 2048`：XLSX 解压总大小预算，默认 2 GiB，上限 16 GiB；不是一次性内存分配。

脚本只发 GET 请求，不创建任务、不触发执行、不写入源平台或目标平台。默认直接连接内网地址，不使用系统代理、不跟随 HTTP 重定向，以免把读取令牌带到登录页或另一台服务器；填写最终可访问的 API 地址。

## 维护验证

```bash
pnpm test:ddt-transfer
```

Python 测试使用临时表格、临时索引和本机 HTTP 服务，不访问真实平台或公网。生产格式兼容测试使用平台实际的流式导出及旧导出实现生成文件，再调用完整 Python CLI 对照两套 HTTP API；不以测试用的 XLSX 拼装器替代实际导出格式。
