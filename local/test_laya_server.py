import unittest
from laya_server import adapt, predict, predict_chunked


class AdapterTests(unittest.TestCase):
    def test_page_task_and_target_descriptions_survive(self):
        state, questions = adapt({
            "state": {"task": {"goal": "Log in", "values": {"email": "test@example.org"}, "history": [{"tool": "click"}], "last_change": {"new_text": "Login"}},
                      "page": {"text": "Login", "elements": [{"i": 7, "tag": "input:email", "label": "Email", "value": ""}], "dialogs": ["Confirm?"]}},
            "questions": {"target": {"type": "choice", "instructions": "Choose an element", "criteria": {"7": None}},
                          "done": {"type": "noul", "instructions": "Is it done?"}}})
        self.assertEqual(state["task"]["values"]["email"], "test@example.org")
        self.assertEqual(state["task"]["last_change"]["new_text"], "Login")
        self.assertEqual(state["page"]["dialogs"], ["Confirm?"])
        self.assertIn("Email", questions["target"]["criteria"]["7"])
        self.assertEqual(questions["done"]["instructions"]["goal"], "Log in")

    def test_group_and_arbitrary_choice_labels(self):
        _, qs = adapt({"state": {"page": {"groups": [{"g": 0, "summary": "Search | Submit"}]}},
                       "questions": {"group": {"type": "choice", "instructions": "Pick", "criteria": {"0": None}},
                                     "q": {"type": "choice", "instructions": "Pick", "criteria": {"yes": None}}}})
        self.assertEqual(qs["group"]["criteria"]["0"], "Search | Submit")
        self.assertEqual(qs["q"]["criteria"]["yes"], "yes")

    def test_wide_choices_preserve_all_probability_mass_and_noul(self):
        class Agent:
            def predict(self, state, questions):
                answers = {}
                for name, q in questions.items():
                    if q["type"] == "noul":
                        answers[name] = {"noul": .25}
                    else:
                        keys = list(q["criteria"])
                        answers[name] = {"choice": keys[0], "confidence": .5,
                                         "probabilities": {k: 1 / len(keys) for k in keys}}
                return {"answers": answers}
        keys = {str(i): f"Element {i}" for i in range(125)}
        answers = predict_chunked(Agent(), {}, {"target": {"type": "choice", "criteria": keys}, "done": {"type": "noul"}})
        self.assertEqual(set(answers["target"]["probabilities"]), set(keys))
        self.assertAlmostEqual(sum(answers["target"]["probabilities"].values()), 1)
        self.assertEqual(answers["done"]["noul"], .25)

    def test_browser_policy_and_general_checks_use_separate_heads(self):
        class Browser:
            def predict(self, state, questions):
                self.assertions = questions
                self.state = state
                return {"answers": {
                    "operation": {"choice": "TYPE_TEXT", "probabilities": {"TYPE_TEXT": .8, "CLICK": .1, "DONE": .1}, "confidence": .6},
                    "click_target": {"choice": "7", "probabilities": {"7": 1}, "confidence": 1},
                    "type_text_target": {"choice": "7", "probabilities": {"7": 1}, "confidence": 1}}}
        class Checks:
            def predict(self, state, questions):
                self.questions = questions
                return {"answers": {"irreversible": {"noul": .02}}}
        browser, checks = Browser(), Checks()
        state, qs = adapt({"state": {"page": {"elements": [{"i": 7, "tag": "input:email", "label": "Email", "value": ""}]},
                                    "task": {"goal": "Enter email", "values": {"email": "test@example.org"}}},
                          "questions": {"tool": {"type": "choice", "instructions": "Next", "criteria": {"type": "Type", "click": "Click", "none": "Done"}},
                                        "target": {"type": "choice", "instructions": "Target", "criteria": {"7": None}},
                                        "done": {"type": "noul", "instructions": "Done?"},
                                        "irreversible": {"type": "noul", "instructions": "Irreversible?"}}})
        answers = predict(browser, checks, state, qs)
        self.assertEqual(answers["tool"]["choice"], "type")
        self.assertEqual(answers["done"]["noul"], .1)
        self.assertEqual(answers["irreversible"]["noul"], .02)
        self.assertEqual(set(checks.questions), {"irreversible"})
        self.assertIn("test@example.org", browser.assertions["operation"]["instructions"]["goal"])


if __name__ == "__main__":
    unittest.main()
