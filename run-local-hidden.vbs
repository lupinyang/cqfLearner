Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "D:\CQF\Jan26\apps\cqf-learner"
shell.Run """D:\Program Files\nodejs\node.exe"" server.js", 0, False
