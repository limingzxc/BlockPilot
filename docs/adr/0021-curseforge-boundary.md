# 0021. CurseForge：能读的不装，装不了的不骗

- **Status**: Accepted（CF 的安装边界已被 ADR-0032 / ADR-0036 部分取代）
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0002, ADR-0004

## Context

主流整合包两个来源：Modrinth（`.mrpack`，已支持）与 CurseForge（zip + `manifest.json`）。

CF 的 manifest 是公开格式，字段在多个启动器的文档里一致：

```json
{
  "minecraft": { "version": "1.20.1",
                 "modLoaders": [{ "id": "forge-47.2.0", "primary": true }] },
  "manifestType": "minecraftModpack",
  "files": [{ "projectID": 238222, "fileID": 5246076, "required": true }]
}
```

与 `.mrpack` 的本质差异只有一处，但它是决定性的：**CF 的 files 只有 projectID/fileID 两个数字，没有 URL 也没有哈希**。mrpack 把下载地址和 sha512 都写死在包里，离线就能装；CF 必须调它的 API（要 key，[console.curseforge.com](https://console.curseforge.com) 申请）才能把 fileID 换成下载地址与校验值。

## Decision

### 1. 预检支持 CF zip，但只承诺能承诺的部分

`preflight` 接受 CF 的 zip，解析 manifest 后：

- **能做的**：MC 版本、加载器（`forge-47.2.0` / `fabric-0.15.3` / `NeoForge-47.1.106`，大小写不统一，按第一个 `-` 切）、Java 版本判定、文件数
- **不能做的**：mod 名称、依赖、兼容性——一个都做不了，因为那需要 API

不能做的就**明说**，产出一条 `CF_API_REQUIRED`，并把全部文件算进 unresolved。按 ADR-0002 的契约，「有东西没校验过」时 verdict 不能是 ok——这正是那一条规则存在的意义。

### 2. deploy 明确拒绝，而不是含糊报错

对 CF zip，deploy 直接返回 `CF_API_REQUIRED`，说明为什么装不了。否则它会在 mrpack 解析那一步报一个含糊的 `BAD_MODPACK`——用户会以为是包坏了。

（原先 deploy 用的是 `CF_API_KEY_REQUIRED`，与 preflight 的 `CF_API_REQUIRED` 是两个码。ADR-0022 之后的架构评审把格式判断收进 `readPackFile`，两个消费者共用同一个码。）

### 3. 没有实现「带 key 的 CF 支持」

技术上不难（API 是 REST，文件元数据里带 `relations` 可以做依赖检查）。但**没有 key 就没法实测**，而按这个仓库的一贯原则：没跑过的代码不能假装跑过（NeoForge 就是先例，ADR-0016 的状态写的是「代码就绪，未实测」）。

把没实测的功能发布出去，用户拿真包一跑就穿帮。宁可让边界清楚可见。

## 细节

- **只解压 `manifest.json` 一个条目**。CF 包的 overrides 动辄上百 MB，全解会吃掉内存
- **`required: false` 的文件不计入必需数**
- **认不出的 loader kind 返回 vanilla 而不是硬套**——LoaderKind 没有更好的占位，且 mod 级校验本来就做不了，误标的代价更高
- zip 里没有 `manifest.json` 时报「不是 CurseForge 整合包」，而不是「文件损坏」

## Consequences

- 拿到 CF 包时，AI 至少能回答三个问题：什么 MC 版本、什么加载器、Java 够不够——这三个回答是可靠的
- 想要完整的 CF 支持，前置条件是一个 API key 和一次真实整合包的实测
- `isCurseforgeZip` 同时被 deploy 用作提前拦截，两个消费者共享同一个判断

## 已知局限

- 无法校验 mod 与 MC/loader 的兼容性（没有元数据）
- `modlist.html`（CF 包里的人类可读清单）没有解析——它不受版本控制，可靠性不如 manifest
- overrides 目录没有在 preflight 里展开——那是 install 的事
