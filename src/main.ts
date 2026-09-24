import { runAction } from "./action.ts";
import { errorMessage, githubErrorCommand } from "./errors.ts";

void runAction().catch((error) => {
  const message = errorMessage(error);
  console.error(message);
  process.stdout.write(githubErrorCommand(error) + "\n");
  process.exitCode = 1;
});
