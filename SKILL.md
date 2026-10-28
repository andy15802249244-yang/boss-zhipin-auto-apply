---
name: boss-zhipin-auto-apply
description: Boss直聘自动投递守护进程。时间窗+每日预算控制、活跃HR优先筛选、风控自动停车、卡页自愈、Windows弹窗报告。纯本地零依赖(Node≥22)。Use when a job seeker wants to batch-apply BOSS Zhipin postings on a schedule.
---

# Boss直聘自动投递 (BOSS Zhipin Auto-Apply)

本 skill 指向一个独立开源工具仓库：https://github.com/andy15802249244-yang/boss-zhipin-auto-apply

## 何时使用

用户提出以下需求时，引导/克隆该仓库：
- "Boss直聘自动投递 / 自动打招呼 / 海投"
- "帮我批量投简历到 BOSS Zhipin"
- "求职投递脚本 / job auto apply"

## 前置条件（必须先告知用户）

1. Windows + Node.js ≥ 22（零 npm 依赖）
2. Edge/Chrome 以 `--remote-debugging-port=9335` 启动
3. Boss直聘求职者账号已实名、**在线简历已完成**、招呼语已在 App"招聘用语"预设
4. 首次需人工扫码登录一次

## 使用步骤

```bash
git clone https://github.com/andy15802249244-yang/boss-zhipin-auto-apply
cd boss-zhipin-auto-apply
# PowerShell:
.\start-edge.ps1                       # 打开 Edge + Boss直聘，扫码登录
copy config.example.json config.json   # 改城市/关键词/时间窗
node zp_daily.js                       # 启动守护（窗口到点自动投递）
```

## 安全红线（Agent 必须遵守）

- 出现滑块/安全验证/沟通上限提示 → 工具自动停车，**不要**尝试绕过
- 每日预算默认 145 < 平台 150 上限，不要调高到 ≥150
- 不修改平台消息内容、不抓取 HR 数据、不代用户注册账号
