# @pinet/pm

Optional project-management behaviour for Pi. It imports neither Chat nor Work and creates no runtime, election, permission tier, goal, or continuation loop.

Install the built package and run `/pinet-pm enable` when the user appoints this session as PM. `/pinet-pm disable` removes the behaviour. `PINET_PM_ENABLED=true` is an explicit operator opt-in for startup. The prompt tells the PM to use whichever tools already exist, arrange acceptance checks, report evidence, and avoid repeated reminder loops.
