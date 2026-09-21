// PSD layer-effect default descriptor payloads (wire-format trees).
/* eslint-disable no-loss-of-precision -- PSD wire descriptor literals retain Photoshop values */

export const LMFX_ROOT_DEFAULT = {
  "classID": "null",
  "Scl": {
    "t": "UntF",
    "v": {
      "type": "#Prc",
      "val": 100
    }
  },
  "masterFXSwitch": {
    "t": "bool",
    "v": true
  }
};

export const EFFECT_DEFAULT_DESCRIPTORS = [
  {
    "classID": "ebbl",
    "enab": {
      "v": true,
      "t": "bool"
    },
    "hglM": {
      "t": "enum",
      "v": {
        "blendMode": "Scrn"
      }
    },
    "hglC": {
      "t": "Objc",
      "v": {
        "classID": "RGBC",
        "Rd": {
          "t": "doub",
          "v": 255
        },
        "Grn": {
          "t": "doub",
          "v": 255
        },
        "Bl": {
          "t": "doub",
          "v": 255
        }
      }
    },
    "hglO": {
      "t": "UntF",
      "v": {
        "type": "#Prc",
        "val": 75
      }
    },
    "sdwM": {
      "t": "enum",
      "v": {
        "blendMode": "Mltp"
      }
    },
    "sdwC": {
      "t": "Objc",
      "v": {
        "classID": "RGBC",
        "Rd": {
          "t": "doub",
          "v": 0
        },
        "Grn": {
          "t": "doub",
          "v": 0
        },
        "Bl": {
          "t": "doub",
          "v": 0
        }
      }
    },
    "sdwO": {
      "t": "UntF",
      "v": {
        "type": "#Prc",
        "val": 75
      }
    },
    "bvlT": {
      "t": "enum",
      "v": {
        "bvlT": "SfBL"
      }
    },
    "bvlS": {
      "t": "enum",
      "v": {
        "BESl": "InrB"
      }
    },
    "uglg": {
      "t": "bool",
      "v": true
    },
    "lagl": {
      "t": "UntF",
      "v": {
        "type": "#Ang",
        "val": 120
      }
    },
    "Lald": {
      "t": "UntF",
      "v": {
        "type": "#Ang",
        "val": 30
      }
    },
    "srgR": {
      "t": "UntF",
      "v": {
        "type": "#Prc",
        "val": 100
      }
    },
    "blur": {
      "t": "UntF",
      "v": {
        "type": "#Pxl",
        "val": 5
      }
    },
    "bvlD": {
      "t": "enum",
      "v": {
        "BESs": "In"
      }
    },
    "TrnS": {
      "t": "Objc",
      "v": {
        "classID": "ShpC",
        "Nm": {
          "t": "TEXT",
          "v": "Linear"
        },
        "Crv": {
          "t": "VlLs",
          "v": [
            {
              "t": "Objc",
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "t": "doub",
                  "v": 0
                },
                "Vrtc": {
                  "t": "doub",
                  "v": 0
                }
              }
            },
            {
              "t": "Objc",
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "t": "doub",
                  "v": 255
                },
                "Vrtc": {
                  "t": "doub",
                  "v": 255
                }
              }
            }
          ]
        }
      }
    },
    "antialiasGloss": {
      "t": "bool",
      "v": false
    },
    "Sftn": {
      "t": "UntF",
      "v": {
        "type": "#Pxl",
        "val": 0
      }
    },
    "useShape": {
      "t": "bool",
      "v": false
    },
    "MpgS": {
      "t": "Objc",
      "v": {
        "classID": "ShpC",
        "Nm": {
          "t": "TEXT",
          "v": "Linear"
        },
        "Crv": {
          "t": "VlLs",
          "v": [
            {
              "t": "Objc",
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "t": "doub",
                  "v": 0
                },
                "Vrtc": {
                  "t": "doub",
                  "v": 0
                }
              }
            },
            {
              "t": "Objc",
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "t": "doub",
                  "v": 255
                },
                "Vrtc": {
                  "t": "doub",
                  "v": 255
                }
              }
            }
          ]
        }
      }
    },
    "AntA": {
      "t": "bool",
      "v": false
    },
    "Inpr": {
      "t": "UntF",
      "v": {
        "type": "#Prc",
        "val": 28
      }
    },
    "useTexture": {
      "t": "bool",
      "v": false
    },
    "InvT": {
      "t": "bool",
      "v": false
    },
    "Algn": {
      "t": "bool",
      "v": true
    },
    "Scl": {
      "t": "UntF",
      "v": {
        "type": "#Prc",
        "val": 100
      }
    },
    "textureDepth": {
      "t": "UntF",
      "v": {
        "type": "#Prc",
        "val": 100
      }
    },
    "Ptrn": {
      "t": "Objc",
      "v": {
        "classID": "Ptrn",
        "Nm": {
          "t": "TEXT",
          "v": "orangeslices"
        },
        "Idnt": {
          "t": "TEXT",
          "v": "339561f5-f162-4a15-ae6b-47ff292cfdc0"
        }
      }
    },
    "phase": {
      "t": "Objc",
      "v": {
        "classID": "Pnt",
        "Hrzn": {
          "t": "doub",
          "v": 0
        },
        "Vrtc": {
          "t": "doub",
          "v": 0
        }
      }
    }
  },
  {
    "classID": "FrFX",
    "enab": {
      "v": true,
      "t": "bool"
    },
    "Md": {
      "v": {
        "blendMode": "Nrml"
      },
      "t": "enum"
    },
    "Opct": {
      "v": {
        "type": "#Prc",
        "val": 100
      },
      "t": "UntF"
    },
    "Styl": {
      "v": {
        "FStl": "OutF"
      },
      "t": "enum"
    },
    "PntT": {
      "v": {
        "FrFl": "SClr"
      },
      "t": "enum"
    },
    "Sz": {
      "v": {
        "type": "#Pxl",
        "val": 3
      },
      "t": "UntF"
    },
    "Clr": {
      "t": "Objc",
      "v": {
        "classID": "RGBC",
        "Rd": {
          "v": 255,
          "t": "doub"
        },
        "Grn": {
          "v": 0,
          "t": "doub"
        },
        "Bl": {
          "v": 0,
          "t": "doub"
        }
      }
    },
    "Grad": {
      "t": "Objc",
      "v": {
        "classID": "Grdn",
        "Nm": {
          "v": "Two Color",
          "t": "TEXT"
        },
        "GrdF": {
          "v": {
            "GrdF": "CstS"
          },
          "t": "enum"
        },
        "Intr": {
          "v": 4096,
          "t": "doub"
        },
        "Clrs": {
          "v": [
            {
              "v": {
                "classID": "Clrt",
                "Clr": {
                  "v": {
                    "classID": "RGBC",
                    "Rd": {
                      "v": 0,
                      "t": "doub"
                    },
                    "Grn": {
                      "v": 0,
                      "t": "doub"
                    },
                    "Bl": {
                      "v": 0,
                      "t": "doub"
                    }
                  },
                  "t": "Objc"
                },
                "Type": {
                  "v": {
                    "Clry": "UsrS"
                  },
                  "t": "enum"
                },
                "Lctn": {
                  "v": 0,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "Clrt",
                "Clr": {
                  "v": {
                    "classID": "RGBC",
                    "Rd": {
                      "v": 255,
                      "t": "doub"
                    },
                    "Grn": {
                      "v": 255,
                      "t": "doub"
                    },
                    "Bl": {
                      "v": 255,
                      "t": "doub"
                    }
                  },
                  "t": "Objc"
                },
                "Type": {
                  "v": {
                    "Clry": "UsrS"
                  },
                  "t": "enum"
                },
                "Lctn": {
                  "v": 4096,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        },
        "Trns": {
          "v": [
            {
              "v": {
                "classID": "TrnS",
                "Opct": {
                  "v": {
                    "type": "#Prc",
                    "val": 100
                  },
                  "t": "UntF"
                },
                "Lctn": {
                  "v": 0,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "TrnS",
                "Opct": {
                  "v": {
                    "type": "#Prc",
                    "val": 100
                  },
                  "t": "UntF"
                },
                "Lctn": {
                  "v": 4096,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        }
      }
    },
    "Rvrs": {
      "v": false,
      "t": "bool"
    },
    "Type": {
      "v": {
        "GrdT": "Lnr"
      },
      "t": "enum"
    },
    "Algn": {
      "v": true,
      "t": "bool"
    },
    "Angl": {
      "v": {
        "type": "#Ang",
        "val": 90
      },
      "t": "UntF"
    },
    "Scl": {
      "v": {
        "type": "#Prc",
        "val": 100
      },
      "t": "UntF"
    },
    "Ofst": {
      "v": {
        "classID": "Pnt",
        "Hrzn": {
          "v": {
            "type": "#Prc",
            "val": 0
          },
          "t": "UntF"
        },
        "Vrtc": {
          "v": {
            "type": "#Prc",
            "val": 0
          },
          "t": "UntF"
        }
      },
      "t": "Objc"
    },
    "Dthr": {
      "v": false,
      "t": "bool"
    },
    "Ptrn": {
      "t": "Objc",
      "v": {
        "classID": "Ptrn",
        "Nm": {
          "v": "orangeslices",
          "t": "TEXT"
        },
        "Idnt": {
          "v": "339561f5-f162-4a15-ae6b-47ff292cfdc0",
          "t": "TEXT"
        }
      }
    },
    "phase": {
      "v": {
        "classID": "Pnt",
        "Hrzn": {
          "v": 0,
          "t": "doub"
        },
        "Vrtc": {
          "v": 0,
          "t": "doub"
        }
      },
      "t": "Objc"
    }
  },
  {
    "classID": "IrSh",
    "enab": {
      "v": true,
      "t": "bool"
    },
    "Md": {
      "v": {
        "blendMode": "Mltp"
      },
      "t": "enum"
    },
    "Opct": {
      "v": {
        "type": "#Prc",
        "val": 75
      },
      "t": "UntF"
    },
    "Clr": {
      "v": {
        "classID": "RGBC",
        "Rd": {
          "v": 0,
          "t": "doub"
        },
        "Grn": {
          "v": 0,
          "t": "doub"
        },
        "Bl": {
          "v": 0,
          "t": "doub"
        }
      },
      "t": "Objc"
    },
    "uglg": {
      "v": true,
      "t": "bool"
    },
    "lagl": {
      "v": {
        "type": "#Ang",
        "val": 120
      },
      "t": "UntF"
    },
    "Dstn": {
      "v": {
        "type": "#Pxl",
        "val": 5
      },
      "t": "UntF"
    },
    "Ckmt": {
      "v": {
        "type": "#Pxl",
        "val": 0
      },
      "t": "UntF"
    },
    "blur": {
      "v": {
        "type": "#Pxl",
        "val": 5
      },
      "t": "UntF"
    },
    "Nose": {
      "v": {
        "type": "#Prc",
        "val": 0
      },
      "t": "UntF"
    },
    "AntA": {
      "v": false,
      "t": "bool"
    },
    "TrnS": {
      "v": {
        "classID": "ShpC",
        "Nm": {
          "v": "Linear",
          "t": "TEXT"
        },
        "Crv": {
          "v": [
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 0,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 0,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 255,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 255,
                  "t": "doub"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        }
      },
      "t": "Objc"
    }
  },
  {
    "classID": "IrGl",
    "enab": {
      "v": true,
      "t": "bool"
    },
    "Md": {
      "v": {
        "blendMode": "Scrn"
      },
      "t": "enum"
    },
    "Opct": {
      "v": {
        "type": "#Prc",
        "val": 75
      },
      "t": "UntF"
    },
    "Clr": {
      "v": {
        "classID": "RGBC",
        "Rd": {
          "v": 255,
          "t": "doub"
        },
        "Grn": {
          "v": 255,
          "t": "doub"
        },
        "Bl": {
          "v": 189.99710083007812,
          "t": "doub"
        }
      },
      "t": "Objc"
    },
    "GlwT": {
      "v": {
        "BETE": "SfBL"
      },
      "t": "enum"
    },
    "Ckmt": {
      "v": {
        "type": "#Pxl",
        "val": 0
      },
      "t": "UntF"
    },
    "blur": {
      "v": {
        "type": "#Pxl",
        "val": 5
      },
      "t": "UntF"
    },
    "ShdN": {
      "v": {
        "type": "#Prc",
        "val": 0
      },
      "t": "UntF"
    },
    "Nose": {
      "v": {
        "type": "#Prc",
        "val": 0
      },
      "t": "UntF"
    },
    "AntA": {
      "v": false,
      "t": "bool"
    },
    "glwS": {
      "v": {
        "IGSr": "SrcE"
      },
      "t": "enum"
    },
    "TrnS": {
      "v": {
        "classID": "ShpC",
        "Nm": {
          "v": "Linear",
          "t": "TEXT"
        },
        "Crv": {
          "v": [
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 0,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 0,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 255,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 255,
                  "t": "doub"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        }
      },
      "t": "Objc"
    },
    "Inpr": {
      "v": {
        "type": "#Prc",
        "val": 50
      },
      "t": "UntF"
    }
  },
  {
    "classID": "ChFX",
    "enab": {
      "v": true,
      "t": "bool"
    },
    "Md": {
      "v": {
        "blendMode": "Mltp"
      },
      "t": "enum"
    },
    "Opct": {
      "v": {
        "type": "#Prc",
        "val": 50
      },
      "t": "UntF"
    },
    "Clr": {
      "v": {
        "classID": "RGBC",
        "Rd": {
          "v": 0,
          "t": "doub"
        },
        "Grn": {
          "v": 0,
          "t": "doub"
        },
        "Bl": {
          "v": 0,
          "t": "doub"
        }
      },
      "t": "Objc"
    },
    "AntA": {
      "v": false,
      "t": "bool"
    },
    "Invr": {
      "v": true,
      "t": "bool"
    },
    "lagl": {
      "v": {
        "type": "#Ang",
        "val": 19
      },
      "t": "UntF"
    },
    "Dstn": {
      "v": {
        "type": "#Pxl",
        "val": 11
      },
      "t": "UntF"
    },
    "blur": {
      "v": {
        "type": "#Pxl",
        "val": 14
      },
      "t": "UntF"
    },
    "MpgS": {
      "v": {
        "classID": "ShpC",
        "Nm": {
          "v": "Gaussian",
          "t": "TEXT"
        },
        "Crv": {
          "v": [
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 0,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 0,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 32,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 7,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 64,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 38,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 96,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 101,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 128,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 166,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 159,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 209,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 191,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 235,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 223,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 248,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 255,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 255,
                  "t": "doub"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        }
      },
      "t": "Objc"
    }
  },
  {
    "classID": "SoFi",
    "enab": {
      "v": true,
      "t": "bool"
    },
    "Md": {
      "v": {
        "blendMode": "Nrml"
      },
      "t": "enum"
    },
    "Opct": {
      "v": {
        "type": "#Prc",
        "val": 100
      },
      "t": "UntF"
    },
    "Clr": {
      "t": "Objc",
      "v": {
        "classID": "RGBC",
        "Rd": {
          "v": 255,
          "t": "doub"
        },
        "Grn": {
          "v": 0,
          "t": "doub"
        },
        "Bl": {
          "v": 0,
          "t": "doub"
        }
      }
    }
  },
  {
    "classID": "GrFl",
    "enab": {
      "v": true,
      "t": "bool"
    },
    "Md": {
      "v": {
        "blendMode": "Nrml"
      },
      "t": "enum"
    },
    "Opct": {
      "v": {
        "type": "#Prc",
        "val": 100
      },
      "t": "UntF"
    },
    "Grad": {
      "t": "Objc",
      "v": {
        "classID": "Grdn",
        "Nm": {
          "v": "Two Color",
          "t": "TEXT"
        },
        "GrdF": {
          "v": {
            "GrdF": "CstS"
          },
          "t": "enum"
        },
        "Intr": {
          "v": 4096,
          "t": "doub"
        },
        "Clrs": {
          "v": [
            {
              "v": {
                "classID": "Clrt",
                "Clr": {
                  "v": {
                    "classID": "RGBC",
                    "Rd": {
                      "v": 0,
                      "t": "doub"
                    },
                    "Grn": {
                      "v": 0,
                      "t": "doub"
                    },
                    "Bl": {
                      "v": 0,
                      "t": "doub"
                    }
                  },
                  "t": "Objc"
                },
                "Type": {
                  "v": {
                    "Clry": "UsrS"
                  },
                  "t": "enum"
                },
                "Lctn": {
                  "v": 0,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "Clrt",
                "Clr": {
                  "v": {
                    "classID": "RGBC",
                    "Rd": {
                      "v": 255,
                      "t": "doub"
                    },
                    "Grn": {
                      "v": 255,
                      "t": "doub"
                    },
                    "Bl": {
                      "v": 255,
                      "t": "doub"
                    }
                  },
                  "t": "Objc"
                },
                "Type": {
                  "v": {
                    "Clry": "UsrS"
                  },
                  "t": "enum"
                },
                "Lctn": {
                  "v": 4096,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        },
        "Trns": {
          "v": [
            {
              "v": {
                "classID": "TrnS",
                "Opct": {
                  "v": {
                    "type": "#Prc",
                    "val": 100
                  },
                  "t": "UntF"
                },
                "Lctn": {
                  "v": 0,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "TrnS",
                "Opct": {
                  "v": {
                    "type": "#Prc",
                    "val": 100
                  },
                  "t": "UntF"
                },
                "Lctn": {
                  "v": 4096,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        }
      }
    },
    "Rvrs": {
      "v": false,
      "t": "bool"
    },
    "Type": {
      "v": {
        "GrdT": "Lnr"
      },
      "t": "enum"
    },
    "Algn": {
      "v": true,
      "t": "bool"
    },
    "Angl": {
      "v": {
        "type": "#Ang",
        "val": 90
      },
      "t": "UntF"
    },
    "Scl": {
      "v": {
        "type": "#Prc",
        "val": 100
      },
      "t": "UntF"
    },
    "Ofst": {
      "v": {
        "classID": "Pnt",
        "Hrzn": {
          "v": {
            "type": "#Prc",
            "val": 0
          },
          "t": "UntF"
        },
        "Vrtc": {
          "v": {
            "type": "#Prc",
            "val": 0
          },
          "t": "UntF"
        }
      },
      "t": "Objc"
    },
    "Dthr": {
      "v": false,
      "t": "bool"
    }
  },
  {
    "classID": "patternFill",
    "enab": {
      "v": true,
      "t": "bool"
    },
    "Md": {
      "v": {
        "blendMode": "Nrml"
      },
      "t": "enum"
    },
    "Opct": {
      "v": {
        "type": "#Prc",
        "val": 100
      },
      "t": "UntF"
    },
    "Ptrn": {
      "t": "Objc",
      "v": {
        "classID": "Ptrn",
        "Nm": {
          "v": "orangeslices",
          "t": "TEXT"
        },
        "Idnt": {
          "v": "339561f5-f162-4a15-ae6b-47ff292cfdc0",
          "t": "TEXT"
        }
      }
    },
    "Scl": {
      "v": {
        "type": "#Prc",
        "val": 100
      },
      "t": "UntF"
    },
    "Algn": {
      "v": true,
      "t": "bool"
    },
    "phase": {
      "v": {
        "classID": "Pnt",
        "Hrzn": {
          "v": 0,
          "t": "doub"
        },
        "Vrtc": {
          "v": 0,
          "t": "doub"
        }
      },
      "t": "Objc"
    }
  },
  {
    "classID": "OrGl",
    "enab": {
      "v": true,
      "t": "bool"
    },
    "Md": {
      "v": {
        "blendMode": "Scrn"
      },
      "t": "enum"
    },
    "Opct": {
      "v": {
        "type": "#Prc",
        "val": 75
      },
      "t": "UntF"
    },
    "Clr": {
      "v": {
        "classID": "RGBC",
        "Rd": {
          "v": 255,
          "t": "doub"
        },
        "Grn": {
          "v": 255,
          "t": "doub"
        },
        "Bl": {
          "v": 189.99710083007812,
          "t": "doub"
        }
      },
      "t": "Objc"
    },
    "GlwT": {
      "v": {
        "BETE": "SfBL"
      },
      "t": "enum"
    },
    "Ckmt": {
      "v": {
        "type": "#Pxl",
        "val": 0
      },
      "t": "UntF"
    },
    "blur": {
      "v": {
        "type": "#Pxl",
        "val": 5
      },
      "t": "UntF"
    },
    "Nose": {
      "v": {
        "type": "#Prc",
        "val": 0
      },
      "t": "UntF"
    },
    "ShdN": {
      "v": {
        "type": "#Prc",
        "val": 0
      },
      "t": "UntF"
    },
    "AntA": {
      "v": false,
      "t": "bool"
    },
    "TrnS": {
      "v": {
        "classID": "ShpC",
        "Nm": {
          "v": "Linear",
          "t": "TEXT"
        },
        "Crv": {
          "v": [
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 0,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 0,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 255,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 255,
                  "t": "doub"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        }
      },
      "t": "Objc"
    },
    "Inpr": {
      "v": {
        "type": "#Prc",
        "val": 50
      },
      "t": "UntF"
    }
  },
  {
    "classID": "DrSh",
    "enab": {
      "v": true,
      "t": "bool"
    },
    "Md": {
      "v": {
        "blendMode": "Mltp"
      },
      "t": "enum"
    },
    "Opct": {
      "v": {
        "type": "#Prc",
        "val": 57
      },
      "t": "UntF"
    },
    "Clr": {
      "v": {
        "classID": "RGBC",
        "Rd": {
          "v": 0,
          "t": "doub"
        },
        "Grn": {
          "v": 0,
          "t": "doub"
        },
        "Bl": {
          "v": 0,
          "t": "doub"
        }
      },
      "t": "Objc"
    },
    "uglg": {
      "v": true,
      "t": "bool"
    },
    "lagl": {
      "v": {
        "type": "#Ang",
        "val": 120
      },
      "t": "UntF"
    },
    "Dstn": {
      "v": {
        "type": "#Pxl",
        "val": 27
      },
      "t": "UntF"
    },
    "Ckmt": {
      "v": {
        "type": "#Pxl",
        "val": 0
      },
      "t": "UntF"
    },
    "blur": {
      "v": {
        "type": "#Pxl",
        "val": 13
      },
      "t": "UntF"
    },
    "Nose": {
      "v": {
        "type": "#Prc",
        "val": 0
      },
      "t": "UntF"
    },
    "AntA": {
      "v": false,
      "t": "bool"
    },
    "TrnS": {
      "v": {
        "classID": "ShpC",
        "Nm": {
          "v": "Lineární",
          "t": "TEXT"
        },
        "Crv": {
          "v": [
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 0,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 0,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "CrPt",
                "Hrzn": {
                  "v": 255,
                  "t": "doub"
                },
                "Vrtc": {
                  "v": 255,
                  "t": "doub"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        }
      },
      "t": "Objc"
    },
    "layerConceals": {
      "v": true,
      "t": "bool"
    }
  }
];

export const DESCRIPTOR_TEMPLATES = {
  solidColorRgb: {
  "t": "Objc",
  "v": {
    "classID": "RGBC",
    "Rd": {
      "v": 255,
      "t": "doub"
    },
    "Grn": {
      "v": 0,
      "t": "doub"
    },
    "Bl": {
      "v": 0,
      "t": "doub"
    }
  }
},
  twoColorGradient: {
  "t": "Objc",
  "v": {
    "classID": "Grdn",
    "Nm": {
      "v": "Two Color",
      "t": "TEXT"
    },
    "GrdF": {
      "v": {
        "GrdF": "CstS"
      },
      "t": "enum"
    },
    "Intr": {
      "v": 4096,
      "t": "doub"
    },
    "Clrs": {
      "v": [
        {
          "v": {
            "classID": "Clrt",
            "Clr": {
              "v": {
                "classID": "RGBC",
                "Rd": {
                  "v": 0,
                  "t": "doub"
                },
                "Grn": {
                  "v": 0,
                  "t": "doub"
                },
                "Bl": {
                  "v": 0,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            "Type": {
              "v": {
                "Clry": "UsrS"
              },
              "t": "enum"
            },
            "Lctn": {
              "v": 0,
              "t": "long"
            },
            "Mdpn": {
              "v": 50,
              "t": "long"
            }
          },
          "t": "Objc"
        },
        {
          "v": {
            "classID": "Clrt",
            "Clr": {
              "v": {
                "classID": "RGBC",
                "Rd": {
                  "v": 255,
                  "t": "doub"
                },
                "Grn": {
                  "v": 255,
                  "t": "doub"
                },
                "Bl": {
                  "v": 255,
                  "t": "doub"
                }
              },
              "t": "Objc"
            },
            "Type": {
              "v": {
                "Clry": "UsrS"
              },
              "t": "enum"
            },
            "Lctn": {
              "v": 4096,
              "t": "long"
            },
            "Mdpn": {
              "v": 50,
              "t": "long"
            }
          },
          "t": "Objc"
        }
      ],
      "t": "VlLs"
    },
    "Trns": {
      "v": [
        {
          "v": {
            "classID": "TrnS",
            "Opct": {
              "v": {
                "type": "#Prc",
                "val": 100
              },
              "t": "UntF"
            },
            "Lctn": {
              "v": 0,
              "t": "long"
            },
            "Mdpn": {
              "v": 50,
              "t": "long"
            }
          },
          "t": "Objc"
        },
        {
          "v": {
            "classID": "TrnS",
            "Opct": {
              "v": {
                "type": "#Prc",
                "val": 100
              },
              "t": "UntF"
            },
            "Lctn": {
              "v": 4096,
              "t": "long"
            },
            "Mdpn": {
              "v": 50,
              "t": "long"
            }
          },
          "t": "Objc"
        }
      ],
      "t": "VlLs"
    }
  }
},
  foregroundBackgroundGradient: {
  "t": "Objc",
  "v": {
    "classID": "Grdn",
    "Nm": {
      "v": "Foreground to Background",
      "t": "TEXT"
    },
    "GrdF": {
      "t": "enum",
      "v": {
        "GrdF": "CstS"
      }
    },
    "Intr": {
      "t": "doub",
      "v": 4096
    },
    "Clrs": {
      "t": "VlLs",
      "v": [
        {
          "t": "Objc",
          "v": {
            "classID": "Clrt",
            "Type": {
              "t": "enum",
              "v": {
                "Clry": "FrgC"
              }
            },
            "Lctn": {
              "t": "long",
              "v": 0
            },
            "Mdpn": {
              "t": "long",
              "v": 50
            }
          }
        },
        {
          "t": "Objc",
          "v": {
            "classID": "Clrt",
            "Type": {
              "t": "enum",
              "v": {
                "Clry": "BckC"
              }
            },
            "Lctn": {
              "t": "long",
              "v": 4096
            },
            "Mdpn": {
              "t": "long",
              "v": 50
            }
          }
        }
      ]
    },
    "Trns": {
      "t": "VlLs",
      "v": [
        {
          "t": "Objc",
          "v": {
            "classID": "TrnS",
            "Opct": {
              "t": "UntF",
              "v": {
                "type": "#Prc",
                "val": 100
              }
            },
            "Lctn": {
              "t": "long",
              "v": 0
            },
            "Mdpn": {
              "t": "long",
              "v": 50
            }
          }
        },
        {
          "t": "Objc",
          "v": {
            "classID": "TrnS",
            "Opct": {
              "t": "UntF",
              "v": {
                "type": "#Prc",
                "val": 100
              }
            },
            "Lctn": {
              "t": "long",
              "v": 4096
            },
            "Mdpn": {
              "t": "long",
              "v": 50
            }
          }
        }
      ]
    }
  }
},
  patternTile: {
  "t": "Objc",
  "v": {
    "classID": "Ptrn",
    "Nm": {
      "v": "orangeslices",
      "t": "TEXT"
    },
    "Idnt": {
      "v": "339561f5-f162-4a15-ae6b-47ff292cfdc0",
      "t": "TEXT"
    }
  }
},
};

export const STROKE_STYLE_DEFAULT = {
  "classID": "strokeStyle",
  "strokeStyleVersion": {
    "t": "long",
    "v": 2
  },
  "strokeEnabled": {
    "t": "bool",
    "v": false
  },
  "fillEnabled": {
    "t": "bool",
    "v": true
  },
  "strokeStyleLineWidth": {
    "t": "UntF",
    "v": {
      "type": "#Pnt",
      "val": 4.38
    }
  },
  "strokeStyleLineDashOffset": {
    "t": "UntF",
    "v": {
      "type": "#Pnt",
      "val": 0
    }
  },
  "strokeStyleMiterLimit": {
    "t": "doub",
    "v": 100
  },
  "strokeStyleLineCapType": {
    "t": "enum",
    "v": {
      "strokeStyleLineCapType": "strokeStyleButtCap"
    }
  },
  "strokeStyleLineJoinType": {
    "t": "enum",
    "v": {
      "strokeStyleLineJoinType": "strokeStyleMiterJoin"
    }
  },
  "strokeStyleLineAlignment": {
    "t": "enum",
    "v": {
      "strokeStyleLineAlignment": "strokeStyleAlignCenter"
    }
  },
  "strokeStyleScaleLock": {
    "t": "bool",
    "v": false
  },
  "strokeStyleStrokeAdjust": {
    "t": "bool",
    "v": false
  },
  "strokeStyleLineDashSet": {
    "t": "VlLs",
    "v": []
  },
  "strokeStyleBlendMode": {
    "t": "enum",
    "v": {
      "blendMode": "Nrml"
    }
  },
  "strokeStyleOpacity": {
    "t": "UntF",
    "v": {
      "type": "#Prc",
      "val": 100
    }
  },
  "strokeStyleContent": {
    "t": "Objc",
    "v": {
      "classID": "solidColorLayer",
      "Clr": {
        "t": "Objc",
        "v": {
          "classID": "RGBC",
          "Rd": {
            "v": 255,
            "t": "doub"
          },
          "Grn": {
            "v": 0,
            "t": "doub"
          },
          "Bl": {
            "v": 0,
            "t": "doub"
          }
        }
      }
    }
  },
  "strokeStyleResolution": {
    "t": "doub",
    "v": 72
  }
};

export const FILL_LAYER_DEFAULTS = [
  {
    "classID": "null",
    "Clr": {
      "t": "Objc",
      "v": {
        "classID": "RGBC",
        "Rd": {
          "v": 255,
          "t": "doub"
        },
        "Grn": {
          "v": 0,
          "t": "doub"
        },
        "Bl": {
          "v": 0,
          "t": "doub"
        }
      }
    }
  },
  {
    "classID": "null",
    "Grad": {
      "t": "Objc",
      "v": {
        "classID": "Grdn",
        "Nm": {
          "v": "Two Color",
          "t": "TEXT"
        },
        "GrdF": {
          "v": {
            "GrdF": "CstS"
          },
          "t": "enum"
        },
        "Intr": {
          "v": 4096,
          "t": "doub"
        },
        "Clrs": {
          "v": [
            {
              "v": {
                "classID": "Clrt",
                "Clr": {
                  "v": {
                    "classID": "RGBC",
                    "Rd": {
                      "v": 0,
                      "t": "doub"
                    },
                    "Grn": {
                      "v": 0,
                      "t": "doub"
                    },
                    "Bl": {
                      "v": 0,
                      "t": "doub"
                    }
                  },
                  "t": "Objc"
                },
                "Type": {
                  "v": {
                    "Clry": "UsrS"
                  },
                  "t": "enum"
                },
                "Lctn": {
                  "v": 0,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "Clrt",
                "Clr": {
                  "v": {
                    "classID": "RGBC",
                    "Rd": {
                      "v": 255,
                      "t": "doub"
                    },
                    "Grn": {
                      "v": 255,
                      "t": "doub"
                    },
                    "Bl": {
                      "v": 255,
                      "t": "doub"
                    }
                  },
                  "t": "Objc"
                },
                "Type": {
                  "v": {
                    "Clry": "UsrS"
                  },
                  "t": "enum"
                },
                "Lctn": {
                  "v": 4096,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        },
        "Trns": {
          "v": [
            {
              "v": {
                "classID": "TrnS",
                "Opct": {
                  "v": {
                    "type": "#Prc",
                    "val": 100
                  },
                  "t": "UntF"
                },
                "Lctn": {
                  "v": 0,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            },
            {
              "v": {
                "classID": "TrnS",
                "Opct": {
                  "v": {
                    "type": "#Prc",
                    "val": 100
                  },
                  "t": "UntF"
                },
                "Lctn": {
                  "v": 4096,
                  "t": "long"
                },
                "Mdpn": {
                  "v": 50,
                  "t": "long"
                }
              },
              "t": "Objc"
            }
          ],
          "t": "VlLs"
        }
      }
    },
    "Dthr": {
      "t": "bool",
      "v": false
    },
    "Rvrs": {
      "t": "bool",
      "v": false
    },
    "Angl": {
      "t": "UntF",
      "v": {
        "type": "#Ang",
        "val": 60
      }
    },
    "Type": {
      "t": "enum",
      "v": {
        "GrdT": "Lnr"
      }
    },
    "Algn": {
      "t": "bool",
      "v": true
    },
    "Scl": {
      "t": "UntF",
      "v": {
        "type": "#Prc",
        "val": 100
      }
    },
    "Ofst": {
      "t": "Objc",
      "v": {
        "classID": "Pnt",
        "Hrzn": {
          "t": "UntF",
          "v": {
            "type": "#Prc",
            "val": 0
          }
        },
        "Vrtc": {
          "t": "UntF",
          "v": {
            "type": "#Prc",
            "val": 0
          }
        }
      }
    }
  },
  {
    "classID": "null",
    "Ptrn": {
      "t": "Objc",
      "v": {
        "classID": "Ptrn",
        "Nm": {
          "v": "orangeslices",
          "t": "TEXT"
        },
        "Idnt": {
          "v": "339561f5-f162-4a15-ae6b-47ff292cfdc0",
          "t": "TEXT"
        }
      }
    },
    "Algn": {
      "v": true,
      "t": "bool"
    },
    "Scl": {
      "v": {
        "type": "#Prc",
        "val": 100
      },
      "t": "UntF"
    },
    "phase": {
      "v": {
        "classID": "Pnt",
        "Hrzn": {
          "v": 0,
          "t": "doub"
        },
        "Vrtc": {
          "v": 0,
          "t": "doub"
        }
      },
      "t": "Objc"
    }
  }
];

/**
 * The constants above are clone sources: effect-defs.js hands out deep copies,
 * never these objects. Freezing turns any accidental in-place mutation (which
 * would silently poison every later clone) into an immediate TypeError.
 * DESCRIPTOR_TEMPLATES is intentionally not frozen — its gradient subtrees are
 * passed by reference into picker widgets.
 */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

deepFreeze(LMFX_ROOT_DEFAULT);
deepFreeze(EFFECT_DEFAULT_DESCRIPTORS);
deepFreeze(STROKE_STYLE_DEFAULT);
deepFreeze(FILL_LAYER_DEFAULTS);
