from backend.main import get_gesture_guides


def test_gesture_learning_guides_use_uploaded_alphabet_and_number_instructions():
    guides = get_gesture_guides()

    assert len(guides["alphabet"]["gestures"]) == 26
    assert guides["alphabet"]["gestures"]["A"] == [
        "Make two fists.",
        "Extend both index fingers.",
        "Touch the fingertips together to form a roof peak.",
    ]
    assert "Hold your hands in front of your chest" in guides["alphabet"]["general"]
    assert len(guides["number"]["gestures"]) == 9
    assert guides["number"]["general"] == (
        "keep the palm facing the viewer and the wrist relaxed."
    )
    assert "For 6 to 9 you use TWO hands" in guides["number"]["two_hand_rule"]
    assert guides["number"]["gestures"]["7"][0] == (
        "First hand: Make a fist."
    )
    assert guides["number"]["gestures"]["7"][-1] == (
        "Second hand: Hold both hands side by side, palms facing the viewer."
    )
