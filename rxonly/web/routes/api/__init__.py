from flask import Blueprint

api_bp = Blueprint("api", __name__, url_prefix="/api")

from rxonly.web.routes.api import nodes
from rxonly.web.routes.api import messages
from rxonly.web.routes.api import channels
from rxonly.web.routes.api import direct_messages
from rxonly.web.routes.api import stats
