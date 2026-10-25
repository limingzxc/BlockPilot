# 0017. Java 自动安装：Adoptium + sha256 + 只做 Windows

- **Status**: Accepted
- **Date**: 2026-10-25
- **Deciders**: @liming
- **Depends on**: ADR-0005、ADR-0006

## Context

ADR-0006 只做了「检测 + 判定」，`JAVA_MISSING` 的 hint 告诉用户该装 Java 17，然后就没有然后了。这是整条链路里唯一一个「诊断完了却让用户自己动手」的地方。

现在补上：真的下载一个 JRE，解压到 `<root>/java`，以后启动优先用它。

## Decision

### 1. 用 Adoptium 的 `assets/latest`，不是 `binary/latest`

两个接口都能拿到二进制：

| 接口 | 行为 | 问题 |
|---|---|---|
| `binary/latest/{v}/ga/.../eclipse` | 302 直接跳二进制 | **拿不到 checksum** |
| `assets/latest/{v}/hotspot?...` | 返回 JSON，含 `package.checksum` | 多一次请求 |

按 ADR-0005 的硬规则「没有哈希的文件不下载」，只能用后者。

### 2. 下载器补 sha256

原来 `pickAlgo` 只认 sha1/sha512，Adoptium 给的是 sha256。现在按强度排序：

```
sha512 > sha256 > sha1
```

优先用最强的那个，而不是「第一个找到的」。

### 3. 只做 Windows

Adoptium 对 Windows 给 zip，对 Linux/macOS 给 tar.gz。

zip 用 fflate 的 `unzipSync` 就够了；tar.gz 需要额外的解压库。

第一版明确报错：

```
ARCHIVE_UNSUPPORTED  目前只支持 zip 解压（Windows 的 Adoptium 构建）
                     拿到的文件是 xxx.tar.gz，需要在 Linux/macOS 上补 tar.gz 支持
```

**这比「装一半失败」好。** 一个明确的能力边界，用户能理解；一个解压到一半的目录，用户只会觉得坏了。

### 4. 装完必须探测验证

解压出来不等于能用。装完立刻跑一次 `java -XshowSettings:properties -version`：

- 跑不起来 → `JAVA_PROBE_FAILED`
- 版本不够 → `JAVA_VERSION_MISMATCH`

不能因为「文件解压了」就宣布成功——那只是把问题推到启动时。

### 5. 已装过就跳过

`<root>/java` 下能找到 `bin/java` 且大版本够，直接返回。不重复下载 46 MB。

## Consequences

**Positive**

- 从「诊断」到「修复」闭合成一条命令：`java install 21`。
- 装好的 JRE 在 `<root>/java` 下，跟实例绑定，不污染系统环境。
- 下载走统一的 `downloadOne`，享受哈希校验 + 多源降级的全部保护。

**Negative**

- **只支持 Windows**（zip）。Linux/macOS 要等 tar.gz 支持。
- **46.7 MB 单次下载，没有断点续传**。网慢的时候只能重来。
- 没有校验 `java.home` 之类的完整性，只验证了能启动。
- 下载源是 GitHub Releases（Adoptium 的 link 指向那里），国内速度不稳定，且 BMCLAPI 不镜像它。

## 实测

```
$ blockpilot java install 21 --root fixtures/mcroot

  安装 Java 21 → D:\BlockPilot\fixtures\mcroot\java

  · jdk-21.0.12.1+1 · 46.7 MB
  · 下载完成，解压中…
  装好了  Java 21 · 21.0.12.1
  D:\BlockPilot\fixtures\mcroot\java\jdk-21.0.12.1+1-jre\bin\java.exe
```

第二次执行会直接命中 `already_installed`，不重复下载。
