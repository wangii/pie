// A scripted epistemic event stream. In demo mode the GUI feeds these through
// the SAME applyLine() interface that the real runtime client uses, so the
// model updates purely from explicit runtime events (no log inference).
//
// Frames: 124 confirmed, 125 discovered config dep, 126 unresolved auth,
//         127 invalidated B31, 128 current (pytest runtime mismatch).

#pragma once

#include <string>
#include <vector>

namespace pie::gui {

inline std::vector<std::string> demoEvents() {
    return {
        // ---- Frame #124: confirmed module relation (closed) ----
        R"({"type":"FrameOpened","id":124,"summary":"confirmed module relation","opened_at":"t0"})",
        R"({"type":"BeliefsSelected","frameId":124,"beliefs":[31,35]})",
        R"({"type":"PlanProduced","frameId":124,"label":"P-124","question":"Does module A depend on B?","intent":"confirm declared module dependency"})",
        R"({"type":"ExecutionStarted","frameId":124})",
        R"({"type":"ToolCalled","frameId":124,"id":"E-60","tool":"grep","command":"import from b in a.py","status":"ok"})",
        R"({"type":"ToolReturned","frameId":124,"id":"E-60","result":"found 3 imports","warning":""})",
        R"({"type":"ExecutionCompleted","frameId":124})",
        R"({"type":"DistillationProduced","frameId":124,"label":"D-30","inputIds":["E-60"],"unexplained":"","interpretation":"dependency confirmed"})",
        R"({"type":"ProposalCreated","frameId":124,"op":"~","belief":"B31","detail":"confidence 0.55 -> 0.85","lhs":"module_a","relation":"depends_on","rhs":"module_b"})",
        R"({"type":"BeliefUpdated","beliefId":31,"confidence":0.85,"status":"open","sourceFrame":124,"lhs":"module_a","relation":"depends_on","rhs":"module_b"})",
        R"({"type":"CursorChanged","frameId":124,"stage":"CLOSED","item":""})",
        R"({"type":"FrameClosed","frameId":124,"status":"CLOSED"})",

        // ---- Frame #125: discovered config dependency (+new) ----
        R"({"type":"FrameOpened","id":125,"summary":"discovered config dependency","opened_at":"t1"})",
        R"({"type":"BeliefsSelected","frameId":125,"beliefs":[31]})",
        R"({"type":"PlanProduced","frameId":125,"label":"P-125","question":"Is there a config dependency hidden here?","intent":"discover undeclared config dependency"})",
        R"({"type":"ExecutionStarted","frameId":125})",
        R"({"type":"ToolCalled","frameId":125,"id":"E-61","tool":"read","command":"config.yaml","status":"ok"})",
        R"({"type":"ToolReturned","frameId":125,"id":"E-61","result":"loads secrets from env","warning":""})",
        R"({"type":"ExecutionCompleted","frameId":125})",
        R"({"type":"DistillationProduced","frameId":125,"label":"D-31","inputIds":["E-61"],"unexplained":"","interpretation":"new dependency surfaced"})",
        R"({"type":"ProposalCreated","frameId":125,"op":"+","belief":"B38","detail":"new","lhs":"config","relation":"loads","rhs":"env"})",
        R"({"type":"BeliefUpdated","beliefId":38,"confidence":0.9,"status":"open","sourceFrame":125,"lhs":"config","relation":"loads","rhs":"env"})",
        R"({"type":"CursorChanged","frameId":125,"stage":"CLOSED","item":""})",
        R"({"type":"FrameClosed","frameId":125,"status":"CLOSED"})",

        // ---- Frame #126: unresolved auth behavior ----
        R"({"type":"FrameOpened","id":126,"summary":"unresolved auth behavior","opened_at":"t2"})",
        R"({"type":"BeliefsSelected","frameId":126,"beliefs":[38]})",
        R"({"type":"PlanProduced","frameId":126,"label":"P-126","question":"How does auth behave?","intent":"characterize auth behavior"})",
        R"({"type":"ExecutionStarted","frameId":126})",
        R"({"type":"ToolCalled","frameId":126,"id":"E-70","tool":"bash","command":"run auth test","status":"failed"})",
        R"({"type":"ToolReturned","frameId":126,"id":"E-70","result":"timeout","warning":"non-deterministic","status":"failed"})",
        R"({"type":"ExecutionCompleted","frameId":126})",
        R"({"type":"DistillationProduced","frameId":126,"label":"D-40","inputIds":["E-70"],"unexplained":"auth outcome is non-deterministic","interpretation":"cannot resolve"})",
        R"({"type":"ProposalCreated","frameId":126,"op":"?","belief":"B38","detail":"unresolved","lhs":"auth","relation":"behaves","rhs":"unpredictably"})",
        R"({"type":"CursorChanged","frameId":126,"stage":"CLOSED","item":""})",
        R"({"type":"FrameClosed","frameId":126,"status":"CLOSED"})",

        // ---- Frame #127: invalidated B31 (falsified) ----
        R"({"type":"FrameOpened","id":127,"summary":"invalidated B31","opened_at":"t3"})",
        R"({"type":"BeliefsSelected","frameId":127,"beliefs":[31]})",
        R"({"type":"PlanProduced","frameId":127,"label":"P-127","question":"Did the refactor remove dependency?","intent":"re-verify module dependency"})",
        R"({"type":"ExecutionStarted","frameId":127})",
        R"({"type":"ToolCalled","frameId":127,"id":"E-80","tool":"grep","command":"import from b in a.py","status":"ok"})",
        R"({"type":"ToolReturned","frameId":127,"id":"E-80","result":"no matches","warning":""})",
        R"({"type":"ExecutionCompleted","frameId":127})",
        R"({"type":"DistillationProduced","frameId":127,"label":"D-41","inputIds":["E-80"],"unexplained":"B31 predicted dependency but it is gone","interpretation":"dependency removed"})",
        R"({"type":"ProposalCreated","frameId":127,"op":"-","belief":"B31","detail":"invalidate","lhs":"module_a","relation":"depends_on","rhs":"module_b"})",
        R"({"type":"BeliefUpdated","beliefId":31,"confidence":0.1,"status":"falsified","sourceFrame":127,"lhs":"module_a","relation":"depends_on","rhs":"module_b"})",
        R"({"type":"CursorChanged","frameId":127,"stage":"CLOSED","item":""})",
        R"({"type":"FrameClosed","frameId":127,"status":"CLOSED"})",

        // ---- Frame #128: current (pytest runtime mismatch) ----
        R"({"type":"FrameOpened","id":128,"summary":"runtime pytest mismatch","opened_at":"t4"})",
        R"({"type":"BeliefsSelected","frameId":128,"beliefs":[42,47]})",
        R"({"type":"PlanProduced","frameId":128,"label":"P-128","question":"Is pytest actually available in runtime?","intent":"verify declared dependency against actual environment"})",
        R"({"type":"ExecutionStarted","frameId":128})",
        R"({"type":"ToolCalled","frameId":128,"id":"E-88","tool":"read","command":"requirements.txt","status":"ok"})",
        R"({"type":"ToolReturned","frameId":128,"id":"E-88","result":"pytest==8.0","warning":""})",
        R"({"type":"ToolCalled","frameId":128,"id":"E-89","tool":"grep","command":"grep pytest .","status":"ok"})",
        R"({"type":"ToolReturned","frameId":128,"id":"E-89","result":"3 files reference pytest","warning":""})",
        R"({"type":"ToolCalled","frameId":128,"id":"E-90","tool":"bash","command":"pip show pytest","status":"running"})",
        R"({"type":"ToolReturned","frameId":128,"id":"E-90","result":"exit code 1","warning":"Package(s) not found: pytest","status":"failed"})",
        R"({"type":"ExecutionStarted","frameId":128})",
        R"({"type":"ExecutionCompleted","frameId":128})",
        R"({"type":"DistillationStarted","frameId":128})",
        R"({"type":"DistillationProduced","frameId":128,"label":"D-42","inputIds":["E-88","E-89","E-90"],"unexplained":"B42 predicts pytest availability, but execution environment does not contain pytest","interpretation":"declared dependency and actual runtime environment differ"})",
        R"({"type":"ProposalCreated","frameId":128,"op":"~","belief":"B42","detail":"confidence 0.62 -> 0.31","lhs":"project","relation":"uses","rhs":"pytest"})",
        R"({"type":"ProposalCreated","frameId":128,"op":"+","belief":"B53","detail":"new","lhs":"runtime_environment","relation":"lacks","rhs":"pytest"})",
        R"({"type":"ProposalCreated","frameId":128,"op":"?","belief":"B54","detail":"unresolved","lhs":"declared_dependencies","relation":"differ_from","rhs":"runtime_environment"})",
        R"({"type":"CursorChanged","frameId":128,"stage":"EXECUTING","item":"E-90"})",
        R"({"type":"BeliefUpdated","beliefId":42,"confidence":0.31,"status":"open","sourceFrame":128,"lhs":"project","relation":"uses","rhs":"pytest"})",
        R"({"type":"BeliefUpdated","beliefId":47,"confidence":0.62,"status":"open","sourceFrame":128,"lhs":"tests","relation":"depend_on","rhs":"fixture_x"})",
        R"({"type":"BeliefUpdated","beliefId":53,"confidence":0.9,"status":"open","sourceFrame":128,"lhs":"runtime_environment","relation":"lacks","rhs":"pytest"})",
    };
}

} // namespace pie::gui
