# Quarkify v1.1.0 ⚛️

> **"Everything is a folder" 철학을 준수하는 로컬 환경 특화형 정적 분석 & 소스 코드 위상 맵(Topology Map) 빌더**

Quarkify는 복잡한 소스 코드를 정적 분석하여 파일 시스템의 물리적 디렉터리 트리로 변환해 주는 범용 정적 분석 엔진입니다. 인간 개발자(Human)는 물론, 특히 AI 코딩 에이전트(LLM)가 로컬 머신에서 소스 코드를 한 줄도 열지 않고 구조와 흐름을 고속으로 탐색 및 조작할 수 있도록 돕는 혁신적인 코드 맵을 구성합니다.

---

## 🎨 핵심 정체성과 철학

### 📁 Everything is a folder (모든 것은 폴더다)
Quarkify는 단일 JSON과 같은 별도의 메타데이터 구조에 의존하지 않습니다. 모든 클래스, 메서드, 필드, 심지어 예외 처리와 개별 제어 구문까지 **오직 물리적인 디렉터리 경로**로 실체화합니다. 
이를 통해 파일 시스템 그 자체가 강력한 코드베이스 지식 데이터베이스(Knowledge Database)가 되며, UNIX 계열의 강력한 CLI 도구들(`ls`, `tree`, `fd`, `find`, `rg`)과 완벽한 시너지를 이룹니다.

### 💻 로컬 개발 환경 특화 (Local-First Design)
클라우드 전송이나 격리된 가상 환경보다 **개발자의 로컬 머신 및 로컬 터미널 환경**에서의 고속 분석과 직관적 탐색을 최우선으로 설계했습니다. 로컬 디스크의 디렉터리 노드를 타고 내려가며 필요한 범위(Scope)를 정밀 격리하는 AI-Agent 친화적 구조를 제공합니다.

### 🤖 AI 코딩 에이전트(LLM)와의 기가 막힌 협업 시너지 (Mind-Blowing Synergy)
Quarkify가 구현한 물리 디렉터리 토폴로지 맵은 AI 에이전트(예: Antigravity, Claude, GPT)와 결합했을 때 **기가 막힌 성능 향상과 시너지**를 발휘합니다.
* **소비 토큰 90% 이상 절감**: 수만 라인의 소스 코드나 대형 프로젝트를 AI에 통째로 읽힐 필요가 없습니다. AI는 쿼크 디렉터리 경로만 보고 필요한 특정 클래스나 함수 폴더로 곧바로 타겟 점프(`cd` 및 `ls`)하여 코드 분석 범위를 정밀 타겟팅하고 무의미한 토큰 낭비를 차단합니다.
* **환각 현상(Hallucination) 0% 수렴**: 쿼크 구조가 추상적인 JSON이 아닌 실제 OS 파일 시스템 폴더로 실체화되어 있기 때문에, AI가 프로젝트 구조를 모호하게 왜곡하여 인식하는 현상이 근본적으로 방지됩니다.
* **비약적인 개발 속도 향상**: AI는 CLI 명령어(`fd`, `tree`)를 활용하여 코드의 의존 연결망(`_axon`)과 각 심볼의 역할(`by_role`)을 한눈에 입체적으로 이해하므로, 단 몇 번의 명령만으로도 기가 막히게 정확하고 안전한 수정 범위를 산출해 낼 수 있습니다.

---

## ✨ 주요 고도화 기능

* **Python 지원 및 런타임 버전 명시**: 파이썬은 버전 의존성이 매우 강하므로, 분석 시점에 시스템의 파이썬 인터프리터 버전을 동적으로 쿼리하여 `python_version__[버전]` 디렉터리로 구성합니다.
* **들여쓰기(Indent) 기반의 Python 구문 파서**: 중괄호가 없는 파이썬 고유의 문법을 공백 깊이 기반으로 재귀 순회하여, 클래스/함수/데코레이터/제어 구조(if, for, try-except-finally)를 완벽하게 물리 노드로 변환합니다.
* **TypeScript & JavaScript CStyle 파서 확장**: 화살표 함수(`const fn = () => ...`), 클래스 내부 멤버 프로퍼티 필드 및 비동기(`async`) 선언을 정교하게 쪼개어 계층 구조화합니다.
* **Spring Framework & Java 어노테이션 실체화**: `@RestController`, `@Autowired`, `@GetMapping("/api")` 등의 클래스/메서드/필드 어노테이션 정보를 하위 속성 인자값까지 분해하여 `annotation__` 디렉터리로 완벽하게 구조화합니다.
* **Ruby `end` 블록 파서 및 DSL 매크로 실체화**: 중괄호나 들여쓰기가 아닌 Ruby의 키워드 블록(`def`/`class`/`module`/`case`/`rescue`) 깊이를 추적하며, heredoc·엔드리스 메서드(`def foo = expr`)·수식어 `if` 를 정확히 처리합니다. 클래스 본문의 DSL 매크로(`has_many`, `validates`, `before_action`)는 Spring 어노테이션과 동일하게 `annotation__` 폴더로 실체화되고, `valid?`/`valid!`/`valid=` 는 하나로 합쳐지지 않고 서로 다른 노드로 보존됩니다.
* **Try-Catch-Finally 블록의 계층적 분해**: 예외 처리 흐름을 정밀 분석하여 `stmt__try` 하위에 본문(`body`), 리소스 선언(`resource`), 예외 시그니처(`catch___Exception`), 그리고 `finally` 영역을 개별 폴더로 쪼개어 시각화합니다.
* **자체 Glob 패턴 탐색기 내장**: `sourceFiles` 설정에 `**/*.java` 나 `src/**/*.ts` 같은 와일드카드를 기입하면, 로컬 소스 디렉터리를 알아서 스캔하고 파일 목록을 매칭하여 한 번에 일괄 물리 빌드를 수행합니다.

---

## 📊 실전 검증 대형 오픈소스 내역

Quarkify는 대규모 상용 및 오픈소스 프로젝트에 적용하여 대용량 물리 노드 빌드 안전성을 성공적으로 검증했습니다.

1. **Project Lombok (Java)**
   * **⚛️ 쿼크 폴더**: **`55,913`개** 물리 생성 완수
   * 복합 자바 어노테이션 프로세서 및 복잡한 컴파일러 AST 조작 로직 분해 검증.
2. **Hoppscotch (TypeScript/JavaScript)**
   * **⚛️ 쿼크 폴더**: **`15,402`개** 물리 생성 완수
   * TS/JS 고유의 클래스, 인터페이스, 화살표 함수, 클래스 내부의 다양한 멤버 프로퍼티(필드) 정밀 격리 빌드 검증.
3. **Python Requests (Python)**
   * **⚛️ 쿼크 폴더**: **`6,726`개** 물리 생성 완수
   * 데코레이터 및 실행 환경 파이썬 런타임 버전의 자동 연동(예: `python_version__3_14_5`) 정합성 검증.
4. **H2 Database (Java)**
   * **⚛️ 쿼크 폴더**: **`15,134`개** 물리 생성 완수
   * 대규모 파일 스토리지 및 DB 관계형 엔진의 쿼크 토폴로지화 검증. 극도로 거대하고 복잡한 switch-case 구조를 지닌 `Parser.java` 내의 460여 개 메서드 분해 통과.

---

## 🌐 인터랙티브 토폴로지 뷰어 (`index.html`)

분석 완료 시 출력 디렉터리 루트에 **`index.html`** 뷰어가 함께 생성됩니다.

* **Overview 모드**: 프로젝트·디렉터리부터 파일·심볼·구문까지 전체 부모–자식 연결을 깊이별 동심원으로 표시합니다.
* **Explore 모드**: 선택한 노드와 직계 하위 노드를 이름이 보이는 그래프로 표시하여 대규모 저장소도 단계적으로 탐색할 수 있습니다.
* **로컬 친화적 단일 파일 포맷**: 모든 위상 구조 데이터가 HTML 파일 내부에 정적으로 임베딩되어 생성되므로, 별도의 웹 서버 구동 없이 브라우저 더블클릭만으로 즉각 구동됩니다.
* **확대·이동·노드 검사**: 휠 또는 툴바로 확대·축소하고, 드래그로 이동하며, 클릭으로 정보를 확인하고 Overview 노드를 더블클릭해 Explore로 진입합니다.

---

## 🗂️ 출력 디렉터리 구조

분석이 완료되면 설정한 출력 폴더 하위에 3가지 코어 폴더와 시각화 도구, AI 지침서가 물리적으로 실체화됩니다.

* **`quark/`**: 소스 코드가 물리적 문맥(클래스/메서드/필드/제어 구문)으로 완전히 쪼개진 계층 디렉터리 구조
* **`_mirror/`**: 쿼크들을 종류별(`by_kind`), 프로젝트 도메인 역할별(`by_role`), 파일별(`by_file`)로 링크하여 다차원 탐색 경로를 제공하는 디렉터리
* **`_axon/`**: 쿼크와 미러 간의 상호 의존성 관계망 및 어셈블리 명령어 사용 빈도 인덱스(`by_opcode`) 정보
* **`index.html`**: 전체 Overview와 집중 Explore 모드를 제공하는 독립형 Canvas 토폴로지 대시보드
* **`ai_context_guide.txt`**: AI 코딩 에이전트(LLM)가 쿼크 구조를 활용하여 소스 코드의 탐색 및 수정 범위를 정밀 타겟팅하도록 유도하는 지침서

---

## 🛠️ 지원 언어 및 명세

* **TypeScript & JavaScript** (`.ts`, `.js`, `.tsx`, `.jsx`, `.mjs`, `.cjs`) - *화살표 함수, 클래스/인터페이스, 비동기(async) 함수 및 클래스 내부 프로퍼티(필드) 파싱 지원*
* **Python** (`.py`) - *실행 환경 버전 동적 수집, 데코레이터 분석, 들여쓰기 기반의 클래스/함수 및 try-except-finally 분해 지원*
* **Java** (`.java`) - *Spring Boot 어노테이션 및 고급 try-catch 흐름 분해 지원*
* **Ruby** (`.rb`) - *`end` 키워드 블록 파서: 모듈/클래스/싱글턴 메서드/엔드리스 메서드, case-when 및 rescue-ensure 분해 지원. `valid?`, `save!`, `name=` 는 서로 다른 노드로 보존되며, 클래스 본문의 DSL 매크로(`has_many`, `validates`, `before_action`)는 Spring 어노테이션과 동일하게 `annotation__` 폴더로 매핑됩니다*
* **Kotlin** (`.kt`, `.kts`) - *Spring Boot 어노테이션, `data`/`sealed`/`enum` 클래스, object 및 companion object 지원. 주 생성자 프로퍼티는 `bound__constructor` 태그가 붙은 `field__` 노드로 물질화되어 생성자 주입 의존성을 파일을 열지 않고 확인할 수 있으며, 각 프로퍼티는 `mutability__val` / `mutability__var` 를 기록합니다. 식 본문 함수(`fun f() = expr`)와 본문 없는 선언도 나머지 파일을 삼키지 않고 정확히 종료됩니다*
* **Zig** (`.zig`)
* **CUDA C++** (`.cu`, `.cuh`)
* **C / C++** (`.cpp`, `.cc`, `.cxx`, `.h`, `.hpp`)
* **Metal MSL** (`.metal`)
* **CUDA 어셈블리 PTX** (`.ptx`)
* **Objective-C / Objective-C++** (`.m`, `.mm`)

---

## 🚀 시작하기

### 1. 요구 사항
* [Node.js](https://nodejs.org/) v22.12.0 이상

### 2. 설정 파일(Config) 작성
공유되거나 신뢰 여부가 불분명한 설정은 실행 코드가 없는 JSON config를 권장합니다.

```json
{
  "name": "spring-demo-analysis",
  "srcDir": "/path/to/spring-project",
  "outDir": "/path/to/output_dir",
  "sourceFiles": [
    "src/main/java/**/*.java"
  ],
  "perfData": {},
  "roleRules": {
    "Controller": "web_endpoint",
    "Repository": "data_access"
  }
}
```

`roleRules`는 심볼 이름에 키가 포함될 때 역할을 지정합니다(대소문자 무시).

커스텀 `guessRole` 로직이 필요한 신뢰된 로컬 workflow에서는 실행 가능한
JavaScript config(`configs/*.mjs`)도 사용할 수 있습니다. 이 파일은 로컬 코드를
실행할 수 있으므로 신뢰하는 출처의 설정에만 사용하세요.

```javascript
// configs/spring_analysis.mjs
export default {
  name: 'spring-demo-analysis',
  srcDir: '/path/to/spring-project',
  outDir: '/path/to/output_dir',

  // 와일드카드 Glob 패턴을 사용하여 일괄 분석 대상 지정 가능
  sourceFiles: [
    'src/main/java/**/*.java',
  ],

  perfData: {},

  // 심볼명에 따른 역할을 분류하는 룰 정의
  guessRole(name) {
    const n = name.toLowerCase();
    if (n.includes('controller') || n.includes('session')) return 'web_endpoint';
    if (n.includes('service')) return 'business_logic';
    return 'general';
  },
};
```

### 3. 실행하기
```bash
node quarkify.mjs configs/spring_analysis.json
```

신뢰된 실행형 config는 명시적으로 허용합니다.

```bash
node quarkify.mjs --allow-executable-config configs/spring_analysis.mjs
```

---

## 🔍 CLI 탐색 예시 (Everything is a folder의 가치)

디스크 상에 물리적으로 구현된 디렉터리 트리를 터미널 명령어로 쿼리하여 소스 코드를 열지 않고도 구조를 즉시 파악합니다.

```bash
# 1. 특정 컨트롤러의 GetMapping API와 try-catch 예외 처리 흐름을 한눈에 시각화
tree output_dir/quark/file__SpringTestController.java/class__SpringTestController/fn__getUser

├── annotation__GetMapping/
│   └── arg__0____users__id_/
└── stmt_0__try/
    ├── body/
    │   └── stmt_0__return/
    ├── catch___IOException_e/
    └── finally/

# 2. 프로젝트 내에서 'equals' 함수를 호출하는 모든 구문 탐색
fd -t d "call__equals" output_dir/quark

# 3. 프로젝트 도메인에서 'web_endpoint' 역할을 담당하는 모든 클래스/메서드 확인
ls output_dir/_mirror/by_role/web_endpoint

# 4. Python 프로젝트 내 특정 API의 파이썬 인터프리터 버전 정보 확인
ls output_dir/quark/file__api.py/python_version__*

# 5. TypeScript/JS 프로젝트에서 state_store(상태 관리) 역할을 담당하는 쿼크 탐색
ls output_dir/_mirror/by_role/state_store
```
