# Harness 物流账单核对插件

在插件面板添加账单和报价（文件、文件夹或 ZIP），选择 Harness 模型和渠道，点击“开始核对”。任务在一个 Harness 会话内执行。提示词决定核对规则，专用工具读取表格、查询配置的物流接口并写出标黄账单和第二步异常明细。模型必须依据材料判断，缺少证据时标待复核。

## GitHub 更新

将源码目录的内容上传到仓库根目录，包括 .github/workflows/package.yml。每次推送后，在 Actions → Build Harness plugin → Artifacts 下载安装产物，解开外层 ZIP，使用里面的 .tgz 更新 Harness 插件。每次构建有独立版本号。运行中的 Harness 实例需要安装更新；仓库不保存主机令牌。

## 本地构建

使用 Node.js 24.9 或更高版本。在仓库根目录运行 npm run build、npm test、npm pack。打包前会重新生成 dist/client.js。业务部署需要能访问所配公共接口；宿主安装插件时会解析 package.json 中的依赖。

## 一次提交的批次协议

next 返回最多 12 个实际数据行号。record 的 passed 只列两步均一致的行；rows 只列异常或待复核的行。本批必须完整覆盖、互不重复。整批校验成功才保存。末批自动导出；用户无需逐批点击。模型调用本身若被供应商中断，插件无法保证该会话完成。
