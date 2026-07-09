# 数芽：双模型小学数学讲题评测平台

一个用于评测小学数学 AI 讲题能力的 Web MVP。AI 老师和学生模型自动进行多轮对话，评测人员可进行人工评分，也可调用 Judge 模型获得参考评分。

## 在线访问

公网正式网站：

### [打开数芽双模型讲题评测平台](https://math-dialogue-evaluator.netlify.app)

无需安装 Node.js，也不需要打开 `localhost`。直接点击上面的链接即可使用。

## 功能

- 题目、参考答案、知识点、参考解析、错因分析输入
- 学生、AI 老师、Judge 三组 OpenAI-compatible 模型配置
- 老师先讲、学生追问的自动或单步对话
- 对话不超过 20 条；学生听懂后由老师总结，最迟在第 19 条完整收束解法和答案
- 五个一级维度、21 个二级指标人工评分
- Judge 结构化自动评分及解析错误兜底
- 错误标签、人工备注、80 分通过基线
- 完整 JSON 和 CSV 导出

## 本地开发（仅开发者需要）

下面的步骤只用于在开发者自己的电脑上修改和调试源码。普通用户不需要执行。

需要 Node.js 20 或更高版本：

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:3000`。这是开发者电脑上的临时本地地址，并非公网网站。

生产构建：

```bash
npm run build
npm start
```

## 模型配置

每个模型需要填写：

- API 地址
- 模型名称或推理接入点 ID
- API Key
- 对应 Prompt

OpenAI 示例地址：

```text
https://api.openai.com/v1/chat/completions
```

火山方舟示例地址：

```text
https://ark.cn-beijing.volces.com/api/v3/chat/completions
```

`ark-` 开头的 Key 应配合火山方舟地址使用，不能填写 OpenAI 地址。

API Key 只在当前页面内存中保存并随请求发送，不会进入 JSON 或 CSV 导出文件。

## 上传到 GitHub

在项目目录执行：

```bash
git init
git add .
git commit -m "Initial commit: math dialogue evaluator"
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

请先在 GitHub 创建一个空仓库，再将上面的远程地址替换为你的仓库地址。不要把 API Key 写入源码或提交到仓库。

## 技术栈

- Next.js
- React
- TypeScript

模型请求由 `/api/chat` 服务端路由转发，因此部署时需要支持 Next.js 服务端运行环境。
