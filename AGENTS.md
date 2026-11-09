## Agent skills

### Issue tracker

Issues and specs live as GitHub issues, managed with the `gh` CLI（已装；路径/凭据见 `docs/agents/environment.md`）. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles, label strings equal to role names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### 架构与改动落点

改命令、事件码、Finding、加载器或实例状态之前，先看 `docs/agents/architecture-map.md`：
它列出每类改动必须同步的文件与不变量。

## 环境

网络（github 被拦 / 本地代理）、两个 git 的能力差异、issue 读写脚本、检查命令：
见 `docs/agents/environment.md`。
