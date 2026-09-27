class StickyNote:
    @classmethod
    def INPUT_TYPES(s): return {"required": {}}
    RETURN_TYPES = ()
    FUNCTION = "nop"
    OUTPUT_NODE = True
    CATEGORY = "utils/note"
    def nop(self): return {}
