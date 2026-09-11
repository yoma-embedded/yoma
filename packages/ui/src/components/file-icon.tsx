import type { Component, JSX } from "solid-js"
import { createMemo, createUniqueId, splitProps, Show } from "solid-js"
import sprite from "./file-icons/sprite.svg"
import type { IconName } from "./file-icons/types"

export type FileIconProps = JSX.GSVGAttributes<SVGSVGElement> & {
  node: { path: string; type: "file" | "directory" }
  expanded?: boolean
  mono?: boolean
}

export const FileIcon: Component<FileIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["node", "class", "classList", "expanded", "mono"])
  const name = createMemo(() => chooseIconName(local.node.path, local.node.type, local.expanded || false))
  const id = `file-icon-mono-${createUniqueId()}`
  return (
    <svg
      data-component="file-icon"
      {...rest}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <Show when={local.mono} fallback={<use href={`${sprite}#${name()}`} />}>
        <defs>
          <mask id={id} mask-type="alpha">
            <use href={`${sprite}#${name()}`} />
          </mask>
        </defs>
        <rect width="100%" height="100%" fill="currentColor" mask={`url(#${id})`} />
      </Show>
    </svg>
  )
}

type IconMaps = {
  fileNames: Record<string, IconName>
  fileExtensions: Record<string, IconName>
  folderNames: Record<string, IconName>
  defaults: {
    file: IconName
    folder: IconName
    folderOpen: IconName
  }
}

const ICON_MAPS: IconMaps = {
  fileNames: {
    // Documentation files
    "readme.md": "Readme",
    "changelog.md": "Changelog",
    license: "Certificate",

    // Node.js files
    "package.json": "Nodejs",
    "package-lock.json": "Nodejs",
    ".nvmrc": "Nodejs",
    ".node-version": "Nodejs",

    // Docker files
    dockerfile: "Docker",
    "docker-compose.yml": "Docker",
    "docker-compose.yaml": "Docker",
    ".dockerignore": "Docker",

    // Config files
    "tsconfig.json": "Tsconfig",
    ".prettierrc": "Prettier",
    ".prettierrc.js": "Prettier",
    ".prettierrc.json": "Prettier",
    ".gitignore": "Git",
    ".gitattributes": "Git",
    makefile: "Makefile",
    cmake: "Cmake",
    "cmakelists.txt": "Cmake",
    "cargo.toml": "Rust",
    "requirements.txt": "Python",
    "pyproject.toml": "Python",
    pipfile: "Python",
    rakefile: "Ruby",
    "composer.json": "Php",
    ".env": "Tune",
    ".env.local": "Tune",
    ".env.development": "Tune",
    ".env.production": "Tune",
    ".env.example": "Tune",
    ".editorconfig": "Editorconfig",
    "favicon.ico": "Favicon",
  },
  fileExtensions: {
    // JavaScript/TypeScript
    ts: "Typescript",
    tsx: "React_ts",
    js: "Javascript",
    jsx: "React",
    mjs: "Javascript",
    cjs: "Javascript",

    // Web languages
    html: "Html",
    htm: "Html",
    css: "Css",
    scss: "Sass",
    sass: "Sass",

    // Data formats
    json: "Json",
    xml: "Xml",
    yml: "Yaml",
    yaml: "Yaml",
    toml: "Toml",

    // Documentation
    md: "Markdown",
    mdx: "Mdx",

    // Programming languages
    py: "Python",
    pyx: "Python",
    pyw: "Python",
    ipynb: "Jupyter",
    rs: "Rust",
    go: "Go",
    java: "Java",
    kt: "Kotlin",
    php: "Php",
    rb: "Ruby",
    cs: "Csharp",
    cpp: "Cpp",
    cc: "Cpp",
    cxx: "Cpp",
    c: "C",
    h: "H",
    hpp: "Hpp",
    swift: "Swift",
    m: "ObjectiveC",
    mm: "ObjectiveCpp",
    dart: "Dart",
    lua: "Lua",
    pl: "Perl",
    nim: "Nim",
    zig: "Zig",

    // Assembly and firmware images
    s: "Assembly",
    asm: "Assembly",
    hex: "Hex",
    srec: "Hex",

    // Hardware description languages
    v: "Verilog",
    sv: "Verilog",
    vh: "Verilog",
    svh: "Verilog",
    vhd: "Verilog",
    vhdl: "Verilog",

    // EDA tooling and constraints
    tcl: "Tcl",
    xdc: "Tcl",
    sdc: "Tcl",
    ucf: "Tcl",

    // Shell scripts
    sh: "Console",
    bash: "Console",
    zsh: "Console",
    fish: "Console",
    ps1: "Powershell",

    // Config/build files
    cfg: "Settings",
    ini: "Settings",
    conf: "Settings",
    properties: "Settings",

    // Media files
    svg: "Svg",
    png: "Image",
    jpg: "Image",
    jpeg: "Image",
    gif: "Image",
    webp: "Image",
    bmp: "Image",
    ico: "Favicon",
    mp4: "Video",
    mov: "Video",
    avi: "Video",
    webm: "Video",
    mp3: "Audio",
    wav: "Audio",
    flac: "Audio",
    ttf: "Font",
    otf: "Font",
    woff: "Font",
    woff2: "Font",

    // Archive files
    zip: "Zip",
    tar: "Zip",
    gz: "Zip",
    rar: "Zip",
    "7z": "Zip",

    // Document files
    pdf: "Pdf",
    xls: "Document",
    xlsx: "Document",

    // Database files
    sql: "Database",
    db: "Database",
    sqlite: "Database",

    // Other
    env: "Tune",
    log: "Log",
    lock: "Lock",
    pem: "Certificate",
    crt: "Certificate",
    patch: "Diff",
    diff: "Diff",
    proto: "Proto",
    graphql: "Graphql",
    gql: "Graphql",
    wasm: "Webassembly",
    dockerfile: "Docker",
  },
  folderNames: {
    // Source code
    src: "FolderSrc",
    source: "FolderSrc",
    lib: "FolderLib",
    libs: "FolderLib",
    include: "FolderLib",
    includes: "FolderLib",
    inc: "FolderLib",

    // Testing
    test: "FolderTest",
    tests: "FolderTest",
    testing: "FolderTest",
    spec: "FolderTest",
    specs: "FolderTest",
    __tests__: "FolderTest",
    e2e: "FolderTest",
    integration: "FolderTest",
    unit: "FolderTest",
    fixtures: "FolderTest",
    mocks: "FolderMock",
    mock: "FolderMock",

    // Dependencies
    node_modules: "FolderNode",
    vendor: "FolderPackages",
    third_party: "FolderPackages",
    "third-party": "FolderPackages",
    external: "FolderPackages",
    packages: "FolderPackages",
    modules: "FolderPackages",
    deps: "FolderPackages",

    // Build/dist
    build: "FolderBuildkite",
    dist: "FolderDist",
    out: "FolderDist",
    output: "FolderDist",
    bin: "FolderDist",
    obj: "FolderDist",
    target: "FolderTarget",

    // Configuration
    config: "FolderConfig",
    configs: "FolderConfig",
    configuration: "FolderConfig",
    conf: "FolderConfig",
    settings: "FolderConfig",
    env: "FolderEnvironment",
    environments: "FolderEnvironment",

    // Docker
    docker: "FolderDocker",
    dockerfiles: "FolderDocker",
    containers: "FolderDocker",

    // Documentation
    docs: "FolderDocs",
    doc: "FolderDocs",
    documentation: "FolderDocs",
    readme: "FolderDocs",

    // Public/assets
    public: "FolderPublic",
    static: "FolderPublic",
    assets: "FolderImages",
    images: "FolderImages",
    img: "FolderImages",
    icons: "FolderImages",
    media: "FolderImages",
    fonts: "FolderFont",
    styles: "FolderCss",
    stylesheets: "FolderCss",
    css: "FolderCss",

    // Scripts and tooling
    scripts: "FolderScripts",
    script: "FolderScripts",
    tools: "FolderTools",
    tool: "FolderTools",
    utils: "FolderUtils",
    util: "FolderUtils",
    utilities: "FolderUtils",
    helpers: "FolderHelper",
    helper: "FolderHelper",

    // Application structure
    components: "FolderComponents",
    component: "FolderComponents",
    views: "FolderViews",
    view: "FolderViews",
    layouts: "FolderLayout",
    layout: "FolderLayout",
    templates: "FolderTemplate",
    template: "FolderTemplate",
    hooks: "FolderHook",
    hook: "FolderHook",
    store: "FolderStore",
    stores: "FolderStore",
    state: "FolderStore",
    services: "FolderApi",
    service: "FolderApi",
    api: "FolderApi",
    apis: "FolderApi",
    routes: "FolderRoutes",
    route: "FolderRoutes",
    routing: "FolderRoutes",
    middleware: "FolderMiddleware",
    middlewares: "FolderMiddleware",
    controllers: "FolderController",
    controller: "FolderController",
    functions: "FolderFunctions",
    function: "FolderFunctions",
    content: "FolderContent",

    // Data
    models: "FolderDatabase",
    model: "FolderDatabase",
    schemas: "FolderDatabase",
    schema: "FolderDatabase",
    migrations: "FolderDatabase",
    migration: "FolderDatabase",
    data: "FolderDatabase",
    database: "FolderDatabase",
    db: "FolderDatabase",
    sql: "FolderDatabase",

    // TypeScript
    types: "FolderTypescript",
    typing: "FolderTypescript",
    typings: "FolderTypescript",
    "@types": "FolderTypescript",
    interfaces: "FolderInterface",
    interface: "FolderInterface",

    // CI/CD
    ".github": "FolderGithub",
    ".gitlab": "FolderGitlab",
    ".circleci": "FolderCircleci",
    ci: "FolderCi",
    ".ci": "FolderCi",
    workflows: "FolderGhWorkflows",

    // Git
    ".git": "FolderGit",

    // Development tools
    ".vscode": "FolderVscode",
    ".idea": "FolderIntellij",
    ".cursor": "FolderCursor",
    ".devcontainer": "FolderContainer",

    // Localization
    i18n: "FolderI18n",
    locales: "FolderI18n",
    locale: "FolderI18n",
    lang: "FolderI18n",
    languages: "FolderI18n",

    // Security
    security: "FolderSecure",
    auth: "FolderSecure",
    authentication: "FolderSecure",
    authorization: "FolderSecure",
    keys: "FolderKeys",
    certs: "FolderKeys",
    certificates: "FolderKeys",

    // Jobs/tasks
    jobs: "FolderJob",
    job: "FolderJob",
    tasks: "FolderTasks",
    task: "FolderTasks",
    cron: "FolderTasks",
    queue: "FolderQueue",
    queues: "FolderQueue",

    // Examples
    examples: "FolderExamples",
    example: "FolderExamples",
    demo: "FolderExamples",
    demos: "FolderExamples",
    samples: "FolderExamples",
    sample: "FolderExamples",

    // Platforms
    desktop: "FolderDesktop",
    mobile: "FolderMobile",
    windows: "FolderWindows",
    macos: "FolderMacos",
    linux: "FolderLinux",

    // Transient
    temp: "FolderTemp",
    tmp: "FolderTemp",
    cache: "FolderTemp",
    logs: "FolderLog",
    log: "FolderLog",
    backup: "FolderBackup",
    backups: "FolderBackup",
    archive: "FolderBackup",
  },
  defaults: {
    file: "Document",
    folder: "Folder",
    folderOpen: "FolderOpen",
  },
}

const toOpenVariant = (icon: IconName): IconName => {
  if (!icon.startsWith("Folder")) return icon
  if (icon.endsWith("_light")) return icon.replace("_light", "Open_light") as IconName
  if (!icon.endsWith("Open")) return (icon + "Open") as IconName
  return icon
}

const basenameOf = (p: string) => p.split("\\").join("/").split("/").filter(Boolean).pop() ?? ""

const folderNameVariants = (name: string) => {
  const n = name.toLowerCase()
  return [n, `.${n}`, `_${n}`, `__${n}__`]
}

const dottedSuffixesDesc = (name: string) => {
  const n = name.toLowerCase()
  const idxs: number[] = []
  for (let i = 0; i < n.length; i++) if (n[i] === ".") idxs.push(i)
  const out = new Set<string>()
  out.add(n) // allow exact whole-name "extensions" like "dockerfile"
  for (const i of idxs) if (i + 1 < n.length) out.add(n.slice(i + 1))
  return Array.from(out).sort((a, b) => b.length - a.length) // longest first
}

export function chooseIconName(path: string, type: "directory" | "file", expanded: boolean): IconName {
  const base = basenameOf(path)
  const baseLower = base.toLowerCase()

  if (type === "directory") {
    for (const cand of folderNameVariants(baseLower)) {
      const icon = ICON_MAPS.folderNames[cand]
      if (icon) return expanded ? toOpenVariant(icon) : icon
    }
    return expanded ? ICON_MAPS.defaults.folderOpen : ICON_MAPS.defaults.folder
  }

  const byName = ICON_MAPS.fileNames[baseLower]
  if (byName) return byName

  for (const ext of dottedSuffixesDesc(baseLower)) {
    const icon = ICON_MAPS.fileExtensions[ext]
    if (icon) return icon
  }

  return ICON_MAPS.defaults.file
}
