from .sticky_note import StickyNote

NODE_CLASS_MAPPINGS = {"StickyNote": StickyNote}
NODE_DISPLAY_NAME_MAPPINGS = {"StickyNote": "便签"}
WEB_DIRECTORY = "./web"
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
