Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "D:\CQF\Jan26\cqf-lexicon"
shell.Run """D:\Program Files\nodejs\node.exe"" server.js", 0, False
