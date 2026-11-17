import type { DocumentationArticle } from "./model";

export const platformGuides: readonly DocumentationArticle[] = [
  {
    topic: "runners",
    label: "执行节点",
    title: "连接执行节点与排查并发不足",
    group: "平台管理",
    summary: "检查节点心跳、槽位、内存与磁盘，理解调度限制及节点维护操作。",
    keywords: ["Agent", "Runner", "并发", "槽位", "内存", "磁盘", "SLES", "卸载", "调度"],
    diagram: {
      title: "节点参与执行的过程",
      caption: "节点在线只是前提，可用槽位与实时资源共同决定是否可以接收新的执行。",
      nodes: [
        { title: "安装注册", detail: "连接平台并取得身份" },
        { title: "资源心跳", detail: "报告槽位与资源指标" },
        { title: "领取执行", detail: "领取任务并持续续租" },
        { title: "完成回报", detail: "上传结果与日志" },
      ],
    },
    sections: [
      {
        id: "connect",
        title: "安装与连接",
        steps: [
          {
            title: "准备执行机",
            detail:
              "确认机器可以访问平台、磁盘目录可写，并具备用例所需的本地运行条件。离线环境使用平台提供的安装资源。",
          },
          {
            title: "安装并注册",
            detail:
              "按执行节点页面的安装指引操作，使用一次性注册凭据；不要将平台中间件凭据交给 Agent。",
          },
          {
            title: "检查运行状态",
            detail: "核对节点名称、版本、心跳、最大并发及项目任务可选范围，再进行一次小规模执行。",
          },
        ],
      },
      {
        id: "capacity",
        title: "为什么没有跑满并发",
        paragraphs: [
          "任务并发、项目在途上限、各节点可用槽位、CPU 和内存限制共同生效。多个任务共用节点时，也会共用这些额度。",
          "在执行详情的调度诊断中查看未满并发的原因，结合节点指标时间判断数据是否新鲜；不要只根据 CPU 使用率推断还有多少可用并发。",
        ],
        table: {
          columns: ["指标", "如何理解"],
          rows: [
            ["待领取", "已经分配，仍需节点领取及准备；与尚未调度的排队状态不同"],
            [
              "内存限制",
              "按平台选定的内存调度策略保护容量；系统可用内存不等于全部可以分配给新用例",
            ],
            ["磁盘提醒", "磁盘余量低于 20% 时留意节点提示，及时处理执行产物与本地缓存"],
          ],
        },
      },
      {
        id: "memory",
        title: "内存策略如何选择",
        paragraphs: [
          "平台设置提供“阈值＋预留”“仅按内存使用率阈值”和“关闭内存调度限制”三种策略。兼容旧系统时可采用仅阈值策略，不要求 cgroup v2。",
          "关闭内存调度限制后仍有 CPU、节点槽位和任务并发限制，但平台不再以此策略阻止内存超配。应观察真实用例峰值，而不是为提高使用率盲目增加并发。",
        ],
      },
      {
        id: "maintenance",
        title: "维护、注销与卸载",
        paragraphs: [
          "维护前优先排空节点，等待在途用例结束；更新失败时查看操作详情和远程输出。注销或删除节点会使旧身份失效，已有执行记录仍保留。",
          "卸载用于清除执行机上的平台 Agent 与执行产物。已删除节点仍尝试连接时，可在对应区域处理；缺少远程认证资料时按提示补充，不应反复重试旧凭据。",
        ],
      },
    ],
    related: ["run-tasks", "execution-records", "case-logs", "platform-settings"],
  },
  {
    topic: "file-assets",
    label: "文件管理",
    title: "管理文件来源、JDK 与用例依赖",
    group: "平台管理",
    summary: "准备运行包，检查上传与更新时间、项目版本引用，并安全清理存储对象。",
    keywords: ["文件来源", "文件管理", "存储空间", "JAR", "JDK", "依赖", "压缩包", "引用"],
    diagram: {
      title: "运行文件与版本的关系",
      caption: "同一对象可以被多个项目版本引用，清理前应先检查全部引用。",
      nodes: [
        { title: "上传文件", detail: "保存并校验内容" },
        { title: "绑定版本", detail: "选择 JDK 与依赖" },
        { title: "执行快照", detail: "使用确定的运行包" },
        { title: "检查引用", detail: "确认后清理存储" },
      ],
    },
    sections: [
      {
        id: "runtime",
        title: "准备 JDK 和依赖",
        paragraphs: [
          "在版本对应的 JDK 与用例依赖页面上传或选择运行包。页面会显示 JDK 上传时间与依赖更新时间，执行前确认版本与架构兼容。",
          "任务执行保存运行配置快照；修改版本配置是为后续执行做准备，不应据此判断历史批次使用了什么包。",
        ],
      },
      {
        id: "sources",
        title: "文件来源与同步",
        paragraphs: [
          "文件来源用于管理导入来源、目录及相关用例。对比与确认同步时先检查新增、变更和缺失项，按页面保留规则处理已有内容。",
          "大量文件的导入清单按界面提供的窗口和展开方式查看；不要将导入任务状态与最终用例是否可执行混为一谈。",
        ],
      },
      {
        id: "usage",
        title: "查看存储引用",
        steps: [
          { title: "进入存储空间", detail: "在文件管理中查看对象及占用。" },
          {
            title: "核对使用范围",
            detail: "展开 JDK 或依赖压缩包的项目、版本引用，注意一个包可能有多个使用方。",
          },
          {
            title: "执行受控清理",
            detail: "先解除允许解除的引用，再按页面提示删除；后台对象清理可能需要一段时间。",
          },
        ],
      },
      {
        id: "jenkins",
        title: "通过 Jenkins 更新依赖",
        paragraphs: [
          "依赖页面提供 Jenkins 对接指导和插件下载，也可配置对应版本的参数化 Jenkins 任务，在弹框中触发构建并查看状态。",
          "插件可以直接上传 Jenkins 执行器上的本地文件，支持工作目录相对路径和绝对路径，并自动计算大小与摘要。",
        ],
      },
    ],
    related: ["project-versions", "testng-cases", "integrations", "log-archives"],
  },
  {
    topic: "log-archives",
    label: "日志管理",
    title: "配置日志数据库与离线归档",
    group: "平台管理",
    summary: "按结束月份归档日志，下载后离线查看，并区分原日志与归档副本的删除操作。",
    keywords: [
      "日志归档",
      "日志数据库",
      "PostgreSQL",
      "MinIO",
      "SQLite",
      "压缩包",
      "下载",
      "空间",
      "wget",
      "curl",
    ],
    diagram: {
      title: "归档、验证与清理",
      caption: "下载完成不等于自动删除；先验证离线包，再分别确认需要清理的副本。",
      nodes: [
        { title: "选择月份", detail: "按北京时间结束月份" },
        { title: "生成归档", detail: "仅收集已结束日志" },
        { title: "下载验证", detail: "解压并离线打开" },
        { title: "确认清理", detail: "原日志与副本分开" },
      ],
    },
    sections: [
      {
        id: "storage",
        title: "日志保存在哪里",
        paragraphs: [
          "日志管理中的日志数据库配置与主平台数据库配置分开维护。Lite 使用本地日志存储；Full 使用配置的 PostgreSQL 日志库，支持多组服务与写入切换，并按日期分库。",
          "检查容量时，数据库大小与数据库宿主机的文件系统余量是两种指标。宿主机余量需要配置对应 Node Exporter，未采集到时不能把数据库大小当作磁盘剩余空间。",
        ],
      },
      {
        id: "create",
        title: "生成月度归档",
        steps: [
          {
            title: "选择月份与范围",
            detail: "在日志归档入口按执行结束月份（北京时间）选择；仍在执行的日志不纳入当月清理。",
          },
          {
            title: "等待后台生成",
            detail:
              "查看归档进度，准备期间可以继续使用平台。Full 的归档副本保存到对象存储，Lite 保存在本地。",
          },
          {
            title: "下载并验证",
            detail:
              "解压后使用附带的 Windows 或 Linux 查看程序启动本机网页，检查日志内容、颜色和检索是否正常。无需安装 Go。",
          },
        ],
      },
      {
        id: "download",
        title: "复制批量下载命令",
        paragraphs: [
          "勾选归档后，可复制 wget 命令、curl 命令或直链，在可访问平台的机器下载。链接属于下载入口，不要将包含下载授权的命令发到无关群组。",
          "操作前检查下载目录及空间，完整保存解压后的查看程序与归档数据。只保存一个网页地址不能作为离线备份。",
        ],
      },
      {
        id: "delete",
        title: "区分两种删除",
        table: {
          columns: ["操作", "影响"],
          rows: [
            [
              "删除原日志",
              "确认归档已完整下载且可以离线打开后，清理数据库中的对应日志；执行结果与记录保留",
            ],
            ["删除平台归档副本", "独立确认后删除 MinIO 或本地的归档压缩包，不会代替您保留离线备份"],
          ],
        },
        note: {
          tone: "warning",
          title: "先验证备份，再清理",
          description:
            "不要同时丢弃原日志、平台归档副本和唯一的离线备份。已清理的在线日志会显示离线归档状态，需使用保存的归档包阅读。",
        },
      },
    ],
    related: ["case-logs", "file-assets", "platform-settings", "execution-records"],
  },
  {
    topic: "integrations",
    label: "自动集成",
    title: "接入 Jenkins、API 与依赖更新流水线",
    group: "平台管理",
    summary: "从任务执行到构建产物上传，找到各入口的接入指导，并使用最小权限的凭据。",
    keywords: ["Jenkins", "插件", "API", "APIKey", "凭据", "参数化", "流水线", "自动化", "上传"],
    diagram: {
      title: "构建产物到平台执行",
      caption: "构建产物可从 Jenkins 执行器直接上传，任务执行与文件上传使用各自的权限。",
      nodes: [
        { title: "准备凭据", detail: "服务账号与 API 密钥" },
        { title: "流水线构建", detail: "生成本地运行文件" },
        { title: "直接上传", detail: "插件计算摘要与大小" },
        { title: "拉起执行", detail: "记录批次并跟踪进展" },
      ],
    },
    sections: [
      {
        id: "credentials",
        title: "账号与凭据",
        paragraphs: [
          "在服务账号和 API 密钥管理中为自动化创建专用身份，按目标项目授予任务执行或文件导入所需权限。不要把个人登录密码写入 Jenkinsfile。",
          "Jenkins 访问平台的 API 密钥与平台触发 Jenkins 时使用的 Jenkins API Token 是两个方向的凭据，不能互相替代。注销密钥后停止使用，并按需要删除保留记录。",
        ],
      },
      {
        id: "plugin",
        title: "安装插件与触发任务",
        steps: [
          {
            title: "打开对接指导",
            detail: "用例任务页面及公开任务执行页提供 Jenkins 说明和内置插件下载入口。",
          },
          {
            title: "按指导配置",
            detail:
              "在 Jenkins 配置平台地址及凭据，选用说明中的任务标识与步骤；安装与版本升级按 Jenkins 管理流程完成。",
          },
          {
            title: "核对执行结果",
            detail:
              "保存返回的批次与进展地址，在公开执行进展页确认实际状态，不要只凭流水线已发送请求判断成功。",
          },
        ],
      },
      {
        id: "dependency",
        title: "流水线上传依赖",
        paragraphs: [
          "用例依赖导入页面的 Jenkins 指导包含本地文件上传用法。插件在 Jenkins Agent 上读取文件，支持相对工作目录路径与绝对路径，内部计算摘要和大小后直接上传。",
          "平台也可反向触发参数化构建：在对应版本填写 Jenkins 任务地址、用户名、API Token 和构建键值对，通过弹框提交并查看队列、构建状态。",
        ],
      },
      {
        id: "case-api",
        title: "单用例执行 API",
        paragraphs: [
          "进入“执行记录 → 执行 API”，选择目标项目版本后，复制页面生成的接口地址与普通／DDT 请求示例。普通用例使用 className 完整类路径，DDT 使用原始业务 caseId；environmentIp 填本次被测环境的单个 IPv4 或 IPv6 地址。",
          "Adapter 默认开启；suiteName、testName 等默认按项目、版本和阶段生成。需要明确阶段时使用对应阶段的接口路径，避免在多个阶段存在同名用例时选错。执行记录显示在单用例执行列表。",
        ],
        table: {
          columns: ["信息", "使用原则"],
          rows: [
            ["用例定位", "普通用例优先类路径，DDT 使用 CaseId；不要把名称相同当成同一个用例"],
            ["环境地址", "明确本次执行的被测环境，避免与正在运行的测试互相影响"],
            ["请求结果", "保留批次、执行标识和 requestId，发生超时时先核对记录再决定是否重试"],
          ],
        },
      },
    ],
    related: ["public-tasks", "file-assets", "account-access", "run-tasks"],
  },
  {
    topic: "platform-settings",
    label: "平台设置",
    title: "配置平台、身份与系统信息",
    group: "平台管理",
    summary: "维护组件连接、调度规则和 AI 参数，并按需查看系统信息及故障上下文。",
    keywords: [
      "设置",
      "初始化",
      "Full",
      "Lite",
      "Redis",
      "NATS",
      "MinIO",
      "PostgreSQL",
      "系统信息",
      "LDAP",
      "模型",
      "提示词",
    ],
    diagram: {
      title: "配置后的验证步骤",
      caption: "配置入口、连接检查和系统信息各司其职；不要通过反复提交业务任务测试基础连接。",
      nodes: [
        { title: "填写配置", detail: "按组件分别设置" },
        { title: "连接检查", detail: "确认地址与凭据" },
        { title: "保存生效", detail: "遵循字段生效提示" },
        { title: "系统信息", detail: "按需查看运行指标" },
      ],
    },
    sections: [
      {
        id: "connections",
        title: "基础组件与日志库",
        paragraphs: [
          "初始化和平台设置按组件提供主库、Redis、NATS、MinIO 的独立表单。按地址、端口、账号等字段填写后使用连接检查，主库与日志数据库分别配置。",
          "Lite 不要求安装 Full 中间件；部署模式是只读信息。配置修改后遵循各字段的保存与生效提示，不要把未保存的连接检查结果当作配置已启用。",
        ],
      },
      {
        id: "scheduling",
        title: "调度与执行时限",
        paragraphs: [
          "项目最大在途数、节点槽位和任务并发同时限制新调度；内存策略在平台调度设置维护。修改后观察调度诊断，已运行的进程不会因增加并发自动改变资源占用。",
          "平台“用例执行超时”决定用例进程的执行期限；排队、领取、租约和上传阶段另有恢复时限。先区分超时发生的阶段，再调整配置。",
        ],
      },
      {
        id: "identity-ai",
        title: "身份与模型配置",
        table: {
          columns: ["配置", "使用提示"],
          rows: [
            ["本地注册", "LDAP 开启后自助注册自动关闭；管理员维护项目角色与成员"],
            ["模型分析", "维护兼容请求地址、模型标识、密钥、上下文、并发与参考提示词"],
            ["主题与时间", "公开页面与工作台共用主题；核对页面显示和导出表头标明的时间语义"],
          ],
        },
      },
      {
        id: "system-information",
        title: "查看系统信息",
        paragraphs: [
          "系统信息独立提供运行和组件概况。点击 PostgreSQL、Redis、NATS、MinIO 等组件卡片按需查看使用详情；持续业务状态仍以平台记录为准。",
          "低负载时较低的内存使用率本身不是故障。排查时综合连接池、队列积压、缓存与磁盘指标，不要通过无意义预占内存判断中间件是否充分利用。",
        ],
      },
      {
        id: "troubleshooting",
        title: "反馈问题时保留哪些信息",
        paragraphs: [
          "保留版本、部署模式、发生时间、操作入口、批次与 requestId，以及页面中的可读错误原因。数据库锁等待还需要区分正在等待的操作与真正持锁的操作。",
          "不要在截图、工单或文档中包含真实密码、API 密钥和连接串。出现数据库繁忙时先检查执行记录，避免将已被平台接收的任务再次提交。",
        ],
      },
    ],
    related: ["runners", "log-archives", "ai-analysis", "account-access"],
  },
];
