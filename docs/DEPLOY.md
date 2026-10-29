# 周末去哪儿 · 从 0 开始的部署教程

本教程假设你**完全没有编程基础**，每一步都写了点哪里、填什么。

- **路线 A：一键部署**（推荐，约 15 分钟）：需要一个 GitHub 账号，Cloudflare 会自动帮你建数据库、设定时任务。
- **路线 B：网页手动部署**（约 25 分钟）：不需要 GitHub，把代码粘贴到 Cloudflare 后台即可。

两条路线部署完以后的步骤（申请 API Key、初始化、装到 iPhone）完全一样。

> 本文中 `<尖括号>` 里的内容表示「换成你自己的」。Cloudflare 后台多半是英文界面，按钮都写了英文原文。

---

## 目录

- [准备工作](#准备工作)
- [路线 A：一键部署](#路线-a一键部署)
- [路线 B：网页手动部署](#路线-b网页手动部署)
- [第 1 步：申请 API Key](#第-1-步申请-api-key)
- [第 2 步：初始化 App](#第-2-步初始化-app)
- [第 3 步：自检，并生成第一期](#第-3-步自检并生成第一期)
- [第 4 步：装到 iPhone 并开启通知](#第-4-步装到-iphone-并开启通知)
- [第 5 步：邀请另一位](#第-5-步邀请另一位)
- [个性化设置](#个性化设置)
- [日常使用](#日常使用)
- [以后更新代码](#以后更新代码)
- [常见问题](#常见问题)

---

## 准备工作

| 东西 | 说明 |
|---|---|
| 电脑 | 用 **Chrome 或 Edge** 浏览器部署。部署好以后基本不用电脑。 |
| iPhone | iOS 16.4 或更新，用 **Safari** 安装。两个人各一台。 |
| 邮箱 | 注册 Cloudflare（免费）。 |
| 手机号 + 支付宝/微信 | 注册 DeepSeek 并充值 ¥10。 |
| GitHub 账号 | 只有路线 A 需要，在 <https://github.com/signup> 免费注册。 |
| （可选）海外信用卡 | 只有想额外用 OpenAI GPT 时才需要。 |

先注册 Cloudflare：打开 <https://dash.cloudflare.com/sign-up>，填邮箱和密码，去邮箱点验证链接，然后登录。

> ⚠️ 登录时如果提示 *There was a problem with verification*，换成普通的 Chrome/Edge 窗口，关掉广告拦截插件后刷新。

---

## 路线 A：一键部署

1. 打开项目主页 <https://github.com/jinjian28/weekend-planner>，点 README 里的 **Deploy to Cloudflare** 按钮。
2. 登录 Cloudflare。页面会要求连接 GitHub，点 **Connect GitHub**，再点 **Authorize** 授权（它要在你的 GitHub 下创建一个仓库副本）。
3. 配置页面上：
   - **Git repository name**：保持 `weekend-planner`。
   - **Worker name**：保持 `weekend-planner`，它会成为网址的一部分。
   - **D1 database**：保持默认，会自动创建。
4. 点 **Create and deploy**（或 **Deploy**），等 1–3 分钟构建完成。
5. 完成后页面会显示网址，形如 `https://weekend-planner.<你的子域名>.workers.dev`。**记下来**。

> 第一次使用 Workers 时，可能会让你给 `workers.dev` 起一个子域名，填个英文小写名字即可。

继续看 [第 1 步：申请 API Key](#第-1-步申请-api-key)。

---

## 路线 B：网页手动部署

### B1. 建数据库

1. 打开 <https://dash.cloudflare.com/?to=/:account/workers/d1>。
2. 点 **Create Database**（或 **Create**），**Name** 填 `weekend-db`，点 **Create**。

### B2. 建 Worker

1. 打开 <https://dash.cloudflare.com/?to=/:account/workers-and-pages>。
2. 点 **Create application** → **Start with Hello World!** → **Get started**。
3. **Name** 填 `weekend`，点 **Deploy**。
4. 记下页面显示的网址：`https://weekend.<你的子域名>.workers.dev`。

### B3.（可选）改个性化配置区

1. 打开 [`dist/worker.js`](../dist/worker.js)，点右上角的 **Download raw file** 下载，然后**右键 → 打开方式 → 记事本**。
2. 最上面方框里的 **「✏️ 个性化配置区」** 可以改第一次初始化时的默认值：

   ```js
   const USER_CONFIG = {
     defaultNames: ['小明', '小红'],          // 两个人的名字
     defaultCity: '杭州',                     // 城市
     defaultActivities: ['攀岩', '露营', '看电影', '探店', '撸猫'],  // 平时爱做的事
     defaultPush: { weekday: 5, time: '12:00' },  // 0=周日 … 4=周四 5=周五 6=周六；北京时间
     defaultCounts: { live: 4, personal: 6 },     // 实时活动 / 个性化建议条数（0–8）
   };
   ```

   > ⚠️ 只改引号里的文字和数字，不要删逗号、括号、引号；引号要用英文的 `'`。**不要在这里写 API Key 或密码。** 不改也没关系，这些都能在 App 里改。

### B4. 粘贴代码并部署

1. 在记事本里 `Ctrl + A` 全选、`Ctrl + C` 复制。
2. 回到 Cloudflare 的 `weekend` 页面，点右上角 **Edit code**。
3. 先在左边代码区点一下，然后 `Ctrl + A`、`Ctrl + V`，覆盖原来的代码。检查第一行是不是 `// 周末去哪儿 (weekend-planner) · build ...`。
4. 点右上角蓝色的 **Deploy**。

> **Deploy 是灰色的？** 等 5–10 秒；还不行就在最后一行末尾按一下空格。右边预览报错是正常的，下一步连上数据库就好了。

### B5. 绑定数据库

1. `weekend` 页面 → **Bindings**（或 **Settings → Bindings**）→ **Add binding** → **D1 database** → **Add binding**。
2. **Variable name** 填大写的 `DB`；**D1 database** 选 `weekend-db`。
3. 点 **Add binding**（或 **Deploy / Save**）。

### B6. 设置定时任务

1. `weekend` 页面 → **Settings** → **Trigger events** → **+ Add** → **Cron Triggers**。
2. 选 **Cron expression**，填 `*/5 * * * *`，看到 *Every 5 minutes* 后点 **Add**。

### B7. 检查

浏览器打开 `https://weekend.<你的子域名>.workers.dev/api/health`：

- 有 `"database":"ok"` 说明数据库连通了。如果提示「没有找到数据库绑定」，检查 B5 的变量名是不是大写 `DB`。
- `"cron":"never"` 刚设置时是正常的，最多 15 分钟后变成 `"ok"`。

---

## 第 1 步：申请 API Key

API Key 是一串以 `sk-` 开头的「钥匙」。**只显示一次**，复制后先存到记事本里，**不要发给别人**。

**DeepSeek（必需）**

1. 打开 <https://platform.deepseek.com>，用手机号注册并登录。
2. 左侧 **充值**，用支付宝或微信充 ¥10。
3. 打开 <https://platform.deepseek.com/api_keys> → **创建 API Key** → 复制保存。

**OpenAI（可选）**：加上后由 DeepSeek 和 GPT 两路搜索、GPT 终审，结果更全，但费用高不少（见[常见问题](#常见问题)）。

1. 打开 <https://platform.openai.com> → 右上角齿轮 **Settings → Billing** → 绑卡充值 $5。
2. 打开 <https://platform.openai.com/api-keys> → **Create new secret key** → 复制保存。

## 第 2 步：初始化 App

1. 用电脑浏览器打开你的 App 网址，会看到「第一次使用」页面。
2. 填写：**访问密码**（至少 6 位，两个人共用）、**两个人的名字**、**城市**、**平时爱做的事**（越具体越好）、**API Key**（至少一个）。
3. 点 **完成初始化**，选「我是谁」。

> Key 只保存在你自己的 Cloudflare 数据库里，界面上只显示前后几位。

## 第 3 步：自检，并生成第一期

1. 底部 **设置** → **🩺 运行状态与自检** → 依次点「测试 DeepSeek（含搜索）」「测试天气」（有 OpenAI 的话再点「测试 OpenAI」），都是 ✅ 就没问题。
2. 回到 **本周** → **✨ 现在生成本周清单**，大约 3–8 分钟。可以先收起进度窗口，生成好会通知你。

## 第 4 步：装到 iPhone 并开启通知

> ⚠️ 必须用 **Safari** 打开并「添加到主屏幕」，以后也必须从**桌面图标**打开，否则收不到通知。

1. iPhone 用 Safari 打开 App 网址。
2. 点底部 **分享按钮**（方框加向上箭头；底部只有地址栏的话，先点右下角「⋯」再点「分享」）→ 往上滑 → **添加到主屏幕** → 打开「作为网页 App 打开」→ **添加**。
3. 从桌面的 🌄 图标打开 → 输入密码 → 选你是谁。
4. 页面顶部出现「🔔 开启通知」，点 **开启** → 系统弹窗选 **允许**。
5. **设置 → 通知 → 🩺 推送体检**：会只给这台手机发一条推送并逐项检查，全部 ✅ 就通了。哪项 ❌ 就按提示操作，多数情况点 **🔄 重新登记本机** 就能解决。

## 第 5 步：邀请另一位

把 **App 网址**和**访问密码**发给 TA，TA 在自己的 iPhone 上重复第 4 步，选自己的名字。之后在「运行状态」里看「推送设备」，两人各 1 台就对了。

---

## 个性化设置

初始化以后，所有个性化都在 App 的 **设置** 里改，下次生成时生效，**不用改代码**：

| 设置项 | 作用 |
|---|---|
| 👤 我是 | 在两个人之间切换身份。 |
| 🔔 通知 | 推送日和推送时间；对方留言或定计划时提醒；周日 20:00 提醒标记「最后去了哪」；备用 Bark 地址（`https://api.day.app/<你的Key>`）；推送体检、重新登记本机。 |
| 📍 城市与出行范围 | 目标城市；周边城市和车程。越远推荐得越少，每期外地活动最多 2 条，车程 ≥2.3 小时的最多 1 条。 |
| 🎯 清单与爱好 | 两类各几条；平时爱做的事；两个人的名字。 |
| 🤖 AI 与密钥 | 更换或补充 API Key；模型名、推理强度、终审是否联网核实。 |
| 🛠️ 其他 | 立即生成、运行状态与自检、改密码、退出登录。 |

**进阶**：想改 AI 的语气或推荐规则，改 `src/05_prompts.js`（提示词）和 `src/06_pipeline.js`（挑选规则、兜底模板），然后运行 `node build.mjs` 重新生成 `dist/worker.js`。

## 日常使用

- **投票**：😍 想去 / 🤔 再看看 / 🙅 不想去。两人都想去的会显示在顶部。
- **留言**：每条单独讨论，最下面还有「这周末的整体想法」。
- **✅ 就它了**：定下来就点。AI 会记录上次做某件事的日期，之后才说得出「有段时间没 xx 了」。
- **🧠 AI 记忆**：看 AI 总结的偏好；在「告诉 AI」里直接写要求；可以让 AI 立即复盘，或手动修改记忆。
- **📚 往期**：查看以前的清单和当时的选择。**🔄 重新生成**时，旧清单会保留在往期里。

## 以后更新代码

- **路线 A**：你的 GitHub 里有一份仓库副本。把新版本的文件（至少 `dist/worker.js`）上传覆盖并提交，Cloudflare 会自动重新部署。
- **路线 B**：下载新的 `dist/worker.js`，重复 B4（粘贴 → Deploy）。

更新代码**不会丢数据**。注意：个性化配置区只在**第一次初始化**时生效，已经初始化过的，请直接在 App「设置」里改。

---

## 常见问题

<details><summary><b>打开网址提示「没有找到数据库绑定」</b></summary>

路线 B 的 B5 变量名必须是大写 `DB`。路线 A 一般不会出现这个问题；如果出现，到 Worker 的 **Bindings** 里确认有一个名为 `DB` 的 D1 绑定。
</details>

<details><summary><b>定时任务显示「从未运行」</b></summary>

在 Worker 的 **Settings → Trigger events** 里确认有 *Every 5 minutes*。刚添加最多要等 15 分钟。
</details>

<details><summary><b>手机打不开网址</b></summary>

`workers.dev` 在国内部分网络下不稳定，换成能访问海外网站的网络再试。想彻底解决，可以买一个自己的域名，在 Worker 的 **Settings → Domains & Routes → Add → Custom domain** 里绑定。
</details>

<details><summary><b>收不到 App 通知</b></summary>

1. 确认是从**桌面图标**打开的 App，不是 Safari 里的网页。
2. App 里点 **设置 → 🩺 推送体检**，按 ❌ 那一项的提示操作；多数情况点 **🔄 重新登记本机** 就好。
3. iPhone **设置 → 通知 → 周末去哪儿**：打开「允许通知」，勾选锁定屏幕、通知中心、横幅。
4. 关掉专注模式 / 勿扰模式。
5. App 开在前台时，iOS 可能只把通知放进通知中心、不弹横幅。锁屏再测一次。
6. **删掉桌面图标重新添加后，必须重新登录并重新开启通知**，iOS 会把它当成一个新 App。
</details>

<details><summary><b>测试 OpenAI 提示「当前云端节点不支持」</b></summary>

这次访问走的是 OpenAI 不支持的节点（比如香港）。手动生成时会自动改用 DeepSeek；定时任务会换节点重试，不影响按时推送。
</details>

<details><summary><b>大概要花多少钱？</b></summary>

Cloudflare 免费。**只用 DeepSeek**：每期约 ¥1，¥10 能用好几个月。**加上 GPT**：粗估每期 ¥5–25，主要是联网搜索读大量网页的 token。想省钱可以在「设置 → AI 与密钥 → 模型设置」里把推理强度调成 `low`，或关闭「终审时允许再联网核实」。每期清单底部都会显示实际用量和花费。
</details>

<details><summary><b>忘记访问密码了</b></summary>

能登录的那位可以在「设置 → 改密码」里改。两人都忘了的话，只能删掉 D1 数据库重建，然后重新初始化，历史数据会丢失。
</details>

<details><summary><b>清单里实时活动很少</b></summary>

可能是 AI 检索失败（比如余额不足）。到「运行状态」看日志和余额；定时任务会自动重试，实在不行也会先推送个性化建议，保证每周推送不落空。
</details>
