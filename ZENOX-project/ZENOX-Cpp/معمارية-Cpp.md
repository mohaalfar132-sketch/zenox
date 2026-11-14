# تصور معماري لـ ZENOX بلغة C++

هذا الملف تصور معماري وتعليمي، وليس كودًا تنفيذيًا ولا يعني أن التطبيق بُني بلغة C++ حتى الآن. واجهة الجوال قد تستخدم React Native/TypeScript، بينما يمكن استخدام C++ في الوحدات التي تحتاج أداءً عاليًا أو طبقة مشتركة.

## الطبقات المقترحة

```text
Mobile UI / Native Shell
        |
Application Gateway
        |
Auth + Invitations + Owner Roles
        |
Policy Engine + Approval Engine
        |
Agent Orchestrator
   |       |        |
Memory  Planner  Tool Registry
        |
Model Router + Provider Adapters
        |
Audit Log + Reports + Backup Manager
        |
Website / API / Download Service / Device Agents
```

## واجهات C++ تصورية

```cpp
#pragma once
#include <string>
#include <vector>
#include <optional>

enum class RiskLevel { Safe, ReviewRequired, Blocked };
enum class TaskState { Proposed, WaitingApproval, Running, Completed, Failed, Stopped };

enum class ToolKind {
    Conversation,
    Translation,
    WebSearch,
    FileAnalysis,
    CodeAssistant,
    WebsiteManager,
    DownloadManager,
    SecurityScanner,
    DeviceAgent
};

struct OwnerCommand {
    std::string id;
    std::string owner_user_id;
    std::string text;
    bool voice_transcribed{false};
};

struct PolicyDecision {
    bool allowed{false};
    RiskLevel risk{RiskLevel::ReviewRequired};
    std::string reason;
    bool requires_owner_confirmation{true};
};

struct TaskReport {
    std::string task_id;
    TaskState state{TaskState::Proposed};
    std::string understood_request;
    std::vector<std::string> completed_steps;
    std::vector<std::string> skipped_steps;
    std::vector<std::string> affected_resources;
    std::vector<std::string> findings;
    std::string next_recommended_step;
};

class PolicyEngine {
public:
    PolicyDecision evaluate(const OwnerCommand& command) const;
};

class AgentOrchestrator {
public:
    TaskReport propose(const OwnerCommand& command) const;
    TaskReport execute_after_approval(const OwnerCommand& command);
    void stop(const std::string& task_id);
};

class LearningReview {
public:
    // Creates a proposed general rule; never activates it automatically.
    std::string propose_general_rule(const std::vector<std::string>& anonymized_evidence);
    bool activate_after_owner_approval(const std::string& rule_id);
    void rollback(const std::string& rule_id);
};
```

## قواعد التنفيذ

- لا يُنفذ الأمر إلا بعد مروره عبر `PolicyEngine`.
- الأوامر الحساسة تنتقل إلى `WaitingApproval`.
- كل خطوة تنتج سجلًا قابلًا للمراجعة.
- لا تحفظ كلمات المرور أو الرموز السرية داخل الكود.
- لا يفحص وكيل الأمن إلا نطاقات مملوكة أو مصرحًا بها.
- لا تُعتمد قاعدة تعلم عامة إلا بعد موافقة المالك.
- لا يتم نشر تحديث قبل إنشاء نسخة احتياطية واختبار الإصدار.
- C++ لا يلغي قيود Android أو iOS أو Windows أو قوانين التوزيع.

## ملاحظة تنفيذية

قرار استخدام C++ النهائي يحدد بعد اختيار البنية الفعلية. من المرجح استخدام C++ فقط في الوحدات المناسبة، مثل محرك أداء مشترك أو معالجة بيانات، بينما تستخدم الواجهة والخدمات طبقاتها الأنسب. لا يبدأ تحويل هذا التصور إلى كود تنفيذي قبل أمر «ابدأ».
