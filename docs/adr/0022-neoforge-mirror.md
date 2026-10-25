# 0022. NeoForge 镜像：forgecdn 换域名 + installer 重打包

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0005, ADR-0015, ADR-0016

## Context

`maven.neoforged.net` 在国内被墙（DNS 可解析，TCP 不通）。ADR-0016 的结论是「没有代理就没法装 NeoForge」——这个结论建立在一个**没验证过的断言**上：「BMCLAPI 不镜像 NeoForge」。

用户指出两点错误：

1. `neoforged.forgecdn.net` 是现成的镜像
2. 找不到镜像时，该去看 HMCL / PCL 这类热门启动器的仓库

复查的结果（2026-10-25）：

- **BMCLAPI 有 neoforged 的路由，但缓存为空**——`/maven/net/neoforged/...` 返回 302 到它的缓存节点，跟随后无内容。我此前说「不镜像」不准确，「有路由但事实上不可用」才是实测结论
- `neoforged.forgecdn.net` 与官方 maven **路径完全兼容**（`/releases/...` 不变，只换域名），maven-metadata.xml、installer.jar、`.sha1` 全部 200，sha1 与官方一致，直连约 180 KB/s
- 出处是 MC百科 论坛 2025-08 的应对帖（当时官方仓库被墙），社区做法就是「把安装包里的 `maven.neoforged.net` 全部替换」。HMCL / PCL 仓库里没有内置它（HMCL 走 BMCLAPI，PCL 无开源实现可查）——所以这层镜像要自己接
- TUNA 等学术镜像没有 neoforge（404）。搜索引擎给出的一条「清华 TUNA 镜像」答案是 AI 编造的，实测 404

## Decision

### 1. forgecdn 作为内置下载源

```ts
createMirrorSource({
  name: 'neoforge-cdn',
  from: 'maven.neoforged.net',
  to: 'https://neoforged.forgecdn.net',
  credit: 'NeoForge CDN · neoforged.forgecdn.net',
})
```

放进 `defaultSources()` 和 `chinaFirstSources()`。它只覆盖这一个域，对其他 URL 返回 null——加进默认列表对其他下载零影响。哈希校验照旧强制，镜像内容错误会被挡下。

### 2. installer 重打包：替换两个 JSON，绝不动 class

installer 是独立 JVM，它的下载地址硬编码在包内三个地方（21.1.264 实测）：

| 条目 | 命中 | 处理 |
|---|---|---|
| `install_profile.json` | 51 处 | 替换 |
| `version.json` | 31 处 | 替换 |
| `SimpleInstaller.class` | 1 处 | **不动** |

class 不动的原因是硬约束：`maven.neoforged.net` 19 字节换成 `neoforged.forgecdn.net` 21 字节会破坏常量池的长度前缀，整个类文件报废。而下载 URL 由两个 JSON 提供，class 里那个常量不参与下载——只改 JSON 就够，社区的重打包做法同样只改这两个文件。

时序：**sha1 校验之后才重打包**。先证明下载的字节是对的，再动它。失败不拦流程（installer 也许直连得通）。

### 3. 什么时候用镜像，什么时候用代理

| 场景 | 行为 |
|---|---|
| 配了 `--proxy` | installer 保持原包，走 JVM 代理直连官方——保真度更高 |
| 没配代理 + neoforge | 重打包走 forgecdn |

### 4. sha1 探测必须走同一套镜像规则

第一版实测撞出来的断裂：下载器走 forgecdn，但 `fetchMavenSha1` 只试官方地址——**镜像还没上场，校验先死了**（`NO_HASH: 取不到 installer 的 sha1`）。

修法：`fetchMavenSha1` 接受候选地址列表，由调用方用与下载同一套 `sources` 生成。这是「同一份数据的所有访问要走同一套源规则」的实例——规则只写在下载器里，别的访问点就会漏。

### 5. 空字符串代理环境变量视为未设置

沙箱和 CI 常把 `HTTPS_PROXY` 设成空值表示「关闭代理」。`??` 不跳过空串，会一路走进「URL 无法解析」的报错。修过之后，清空这些变量即可获得真正的直连。

## 实测

**完全不走代理**（清空全部代理环境变量），全新版本 21.1.265：

```
deploy fixtures/neoforge-mirror.mrpack → 装好了 1.21.1 + neoforge 21.1.265 · 1m31s
run neoforge-21.1.265                  → ModLauncher 11.0.5 / NeoForge 21.1.265
                                         OpenAL initialized / Sound engine started
                                         纹理图集创建成功 · 正常退出
```

maven.neoforged.net 全程未访问——installer 本体与内部下载都走 forgecdn。

## Consequences

**Positive**

- 国内无代理即可装 NeoForge 整合包
- `createMirrorSource` 的「路径兼容镜像」模式得到第二个实例（BMCLAPI、forgecdn），配置化接口被证明是对的抽象

**Negative**

- forgecdn 是社区镜像，没有官方协议或 SLA；sha1 校验是唯一防线
- installer 重打包依赖「下载 URL 在 JSON 里」这个实现细节。NeoForge 改成在 class 里解析 URL 时会失效——失效模式是「直连官方」而不是装坏包（有哈希兜底），可接受
