# 0005. 下载与镜像：源是候选，哈希是唯一裁判

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0003

## Context

`RepairPlan.installs` 已经能给出「装哪个文件、从哪下、多大、哈希多少」。现在要真的把文件落到磁盘。

难点不在 HTTP，在**怎么判断下到的文件是对的**，以及**镜像到底覆盖什么**。查证过的事实（2026-10-25 实测）：

| 镜像 | 覆盖 | 规则 | 实测 |
|---|---|---|---|
| BMCLAPI | Mojang 版本/资源/库、Forge/NeoForge/Fabric maven | 前缀替换，路径与官方 100% 兼容 | 可用 |
| MCIM | Modrinth / CurseForge 的文件与 API | `cdn.modrinth.com` → `mod.mcimirror.top`（路径不变）；`api.modrinth.com` → `mod.mcimirror.top/modrinth` | API `200`；文件 `/data/...` 返回 **302 跳回官方 CDN** |
| Lss233's.Mirror | 聚合 Maven：forge、neoforge、libraries.minecraft.net、fabric | 文档地址 `lss233.littleservice.cn/repositories/minecraft` | 302 → `crystal.app.lss233.com/repositories/...` 后 **404**；**评估后弃用** |

三个结论：

1. **BMCLAPI 不覆盖 Modrinth CDN。** 它对模组文件没意义，只对启动原版游戏有用。
2. **MCIM 的 API 镜像真实有效，文件镜像未必加速。** 官方 README 自己写着「文件下载可能存在一定的不稳定性，建议启动器在未能成功下载的情况下才尝试使用镜像源」。实测那个 Sodium 文件返回 302 跳回官方，说明它没缓存。
3. **Lss233's.Mirror 评估后弃用。** 它一度是最值得关注的 Minecraft Maven 镜像，覆盖 `libraries.minecraft.net`、Forge、NeoForge、Fabric，正是启动器需要的。但三条理由否掉了它：
   - 2026-10-25 实测所有已知端点都取不到 `maven-metadata.xml`（主站 302 到 `crystal.app` 后 404）
   - 对**本项目有用**的那部分，BMCLAPI 已经覆盖
   - 它剩下的差异化价值集中在插件服生态（spigot、paper、PlaceholderAPI、Nukkit），启动器用不上

   不内置，但保留 `createMirrorSource` 作为扩展点——需要的人自己接，不用改源码。

MCIM 还要求**启动器先提交 UA 登记**（可能启用白名单），并禁止「在 MCIM 上对接口二次封装」——后者指的是不能把它的 API 再包一层对外提供服务，不是禁止启动器使用。

## Decision

### 1. 源是候选列表，不是唯一地址

```ts
interface DownloadSource {
  name: string
  /** null = 这个源不覆盖该 URL，调用方静默跳过 */
  rewrite(url: URL): string | null
}
```

调用方按顺序尝试，直到某个源成功。

**`null` 与「直连」必须区分开。** 我的第一版让 `direct.rewrite` 返回 `null`，结果所有 Modrinth 下载都被记成 `bmclapi` 成功——一个纯粹因为语义重载造成的假记录。现在直连源返回原 URL，不覆盖才返回 `null`。

### 2. 每个源下载后都要校验哈希，失败等同于下载失败

这是整条链路的唯一裁判。镜像活着、HTTP 200、文件大小对得上，都不能说明内容正确。

```
下载到 .part → 边下边算 sha1/sha512 → 哈希不符则删掉 .part、换下一个源
```

校验失败**不能**当成「这个源暂时不可用然后继续用它的文件」——那等于把投毒直接写进玩家的 mods 目录。

### 3. 没有哈希的任务拒绝下载

`hashes` 里既没有 sha1 也没有 sha512 → 直接抛错。宁可不下，不可下错。

### 4. `.part` + rename 保证原子性

下载先写 `xxx.jar.part`，校验通过才 `rename` 成 `xxx.jar`。中途崩溃不会留下一个看起来正常的半个 jar。

第一版不做 Range 断点续传——模组文件通常 1–5 MB，收益低于复杂度。

### 5. 三层来源：宿主镜像、直连、内容镜像

```ts
defaultSources()      // [bmclapi, direct, mcim]  国内可用但求稳
chinaFirstSources()   // [bmclapi, mcim, direct]  国内优先
```

顺序是有讲究的：

- **BMCLAPI 排第一**——它是明确为此设计的加速服务，覆盖 Mojang 域。
- **MCIM 排最后**——官方自己建议「下载失败后再用镜像」，而且文件镜像未必缓存。
- **直连夹在中间**——对 Modrinth CDN，direct 是唯一确定能拿到正确字节的路。

### 6. 镜像地址必须可配置，不能硬编码

```ts
createMirrorSource({ name, from, to, pathPrefix })
```

镜像站地址会变——有的站点在两年内换了三次域名。任何写死在源码里的镜像 URL 都注定过期。给使用者一个配置项，比让他们改代码现实。

**URL 规则仍然必须来自镜像自己的文档，不能猜**——这正是 ADR-0004 里「不做模糊映射」的同一条原则。

## Consequences

**Positive**

- 镜像投毒被哈希挡住。测试里有一个专门的用例：一个返回错误内容的源排在前面，最终仍从正确的源拿到文件。
- 缓存命中不重复下载。已存在且哈希匹配直接跳过，这一点用真实 Sodium jar 验证过。
- 源的实际生效者被记录下来（`DownloadOutcome.source`），出问题能追溯是哪家给的。

**Negative**

- **没有断点续传**：一次 20 MB 的下载失败要重来。
- **没有镜像自动发现**：用户得自己填镜像列表。
- 并发 4 路是写死的，没有按带宽自适应。
- 哈希只算 sha1（若有 sha512 则用 sha512），没有同时校验两者。

## 验证

`fixtures/closure.mrpack` → `install`：

```
↓ sodium-fabric-0.5.13+mc1.20.1.jar  949 KB · direct
完成 1 个，失败 0 个，共 949 KB
```

第二次执行：

```
= sodium-fabric-0.5.13+mc1.20.1.jar  已存在且校验通过
```

下载下来的 jar 被离线读取器成功解析，说明两条链路（在线元数据 / 离线 jar 解析）产出的东西是互相认识的。

## Amendment（2026-10-25）：一处事实性错误

这份 ADR 的初版写过「Modrinth CDN 没有可公开依赖的镜像」。**这是错的。** MCIM 就是，而且替换规则明明白白写在它的 README 里。

同时我整份调研**漏掉了 Lss233's.Mirror**——它恰好覆盖启动器最需要的那几个仓库：`libraries.minecraft.net`、`maven.minecraftforge.net`、NeoForge、Fabric。

漏掉是调研失误；补查之后评估弃用，是决策。这两件事不能互相抵消——**一个候选要先被认真看过，才有资格被否掉**，而不是因为没看见所以当它不存在。

错误的原因值得记下来：我把「文件加速」和「API 加速」混为一谈。看到 MCIM 的文件端点返回 302 跳回官方 CDN，就判定它「不可用」，却没有去读文档里写的替换规则，也没有区分「API 镜像」和「文件镜像」是两件事。

修正：

- MCIM 接入两处：`mcimSource`（下载候选）+ `MODRINTH_API_MCIM`（元数据查询）。后者是它真正的价值所在——API 加速是确定有效的。
- Lss233 **不内置**（见上文「评估后弃用」三条理由），只保留 `createMirrorSource` 作为扩展点。
- 源顺序从 `[bmclapi, direct]` 调整为 `[bmclapi, direct, mcim]`，另提供 `chinaFirstSources()`。

仍然成立的判断：**镜像给的字节不一定是你要的字节，哈希是唯一裁判。** 这条没有因为任何镜像的存在而改变。

## 义务：这些是协议，不是建议

用别人的公益服务，就得守别人的规矩。查证到的硬性要求：

| 服务 | 要求 | 落地方式 |
|---|---|---|
| BMCLAPI | UA 以 `${NAME}/${VERSION}` 开头（[MCLF-CN/docs#2](https://github.com/MCLF-CN/docs/issues/2)，维护者本人提出，示例 `BMCLNG/4.10.0.1234`） | `USER_AGENT = 'BlockPilot/0.0.1'`，集中在 `src/core/user-agent.ts` |
| BMCLAPI | **「所有使用 BMCLAPI 的程序必需在下载界面或其他可视部分标明来源」**、禁止在其上二次封装其他协议 | `DownloadSource.credit` 是必填字段，透传到 `DownloadOutcome`，CLI 打印「资源来源」 |
| MCIM | 使用前登记启动器 UA（[mcim-rust-api#12](https://github.com/mcmod-info-mirror/mcim-rust-api/issues/12)），禁止二次封装接口 | UA 集中定义；本仓库只做客户端，不对外提供镜像服务 |

把 `credit` 做成**必填字段**而不是可选注释，是有意的：一张写在 README 里的合规声明，代码不会执行它；一个必须填的字段，编译器会。

## 实测补记：HTTP 200 的假成功

验证 MCIM 时抓到一个教科书级的失败模式。同一个 URL、同一分钟：

| 客户端 | 状态码 | 大小 | 内容 |
|---|---|---|---|
| `curl` | 200 | 971,552 B | 正确的 jar |
| Node `fetch` | **200** | 2,231 B | `Service Temporarily Unavailable` 的 HTML |

也就是说，服务不可用的时候它**不会返回 5xx**，而是返回 200 加一张错误页。

如果下载器只看 `res.ok` 就落盘，玩家的 `mods/` 里会多出一个 2 KB 的 HTML 文件叫 `sodium.jar`，游戏启动时崩在一个完全不相干的地方，而预检的结论是「已安装」。

现在的两层防护：

1. **先比字节数**——`expectedSize` 不符立即失败，比 971 KB 的哈希便宜
2. **再比哈希**——不符则换源

实测中 MCIM 这一路被第 1 层挡下（`size mismatch`），自动降级到 direct 拿到正确文件。**这条比任何镜像配置都重要。**
